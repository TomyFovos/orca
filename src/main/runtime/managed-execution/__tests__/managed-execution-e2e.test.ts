import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { isAuthorityRegistryLoaded } from '../authority-registry'
import { canonicalBytes } from '../canonical'
import { startManagedExecutionEndpoint } from '../endpoint'
import {
  EXECUTION_REQUEST_CONTRACT_VERSIONS,
  type ExecutionOperation
} from '../execution-request-contract'
import type { ExecuteRequest } from '../issuer'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'

const AI_DE_PATH = '/home/atsou/src/github.com/TomyFovos/AI-DE'
const AI_DE_SCHEMA_VALIDATOR = path.join(
  AI_DE_PATH,
  'harness/runtime/execution-packet/schema-validator.js'
)
const AI_DE_RECEIPT_SCHEMA = path.join(
  AI_DE_PATH,
  'knowledge/schemas/execution-receipt-1.schema.json'
)
const keyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

const authorityRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-authority-registry-'))
const authorityRegistryPath = path.join(authorityRegistryDir, 'authorities.json')
const previousAuthorityRegistryPath = process.env.ORCA_MANAGED_AUTHORITY_REGISTRY_PATH

function sha256Canonical(value: unknown): string {
  const bytes = canonicalBytes(value)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function createSignedRequest(requestId: string = randomUUID(), payloadSuffix = ''): ExecuteRequest {
  return createSignedOperationRequest(
    'start',
    {
      adapter: 'codex',
      model: { adapter: 'codex', concrete_model_id: 'gpt-5' },
      write_permission: 'workspace-write',
      prompt: payloadSuffix
    },
    `sha256:${'0'.repeat(64)}`,
    requestId
  )
}

function createSignedOperationRequest(
  operation: ExecutionOperation,
  payload: Record<string, unknown>,
  launchPlanDigest: string | null,
  requestId: string = randomUUID()
): ExecuteRequest {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 60_000)
  const binding = {
    authority_id: 'managed-e2e-authority',
    request_id: requestId,
    case_id: 'managed-e2e-case',
    task_id: 'managed-e2e-task',
    attempt_id: 'managed-e2e-attempt',
    packet_digest: `sha256:${'0'.repeat(64)}`,
    launch_plan_digest: launchPlanDigest,
    operation,
    payload_digest: sha256Canonical(payload),
    ...EXECUTION_REQUEST_CONTRACT_VERSIONS
  }
  const signature = sign(
    null,
    canonicalBytes({
      binding,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString()
    }),
    keyPair.privateKey
  )

  return {
    schema: 'ai-de.execution-envelope/1',
    signature: {
      algorithm: 'ed25519',
      canonicalization: 'RFC8785-JCS',
      value: signature.toString('hex')
    },
    binding,
    payload,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString()
  }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function validateWithAiDe(receipt: unknown, label: string): Promise<string> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-managed-e2e-'))
  const receiptPath = path.join(outputDir, `${label}.json`)
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

  try {
    return await new Promise((resolve, reject) => {
      const validatorSource = `
        const fs = require('node:fs')
        const { validateJsonSchema } = require(${JSON.stringify(AI_DE_SCHEMA_VALIDATOR)})
        const receipt = JSON.parse(fs.readFileSync(process.env.ORCA_RECEIPT_PATH, 'utf8'))
        const schema = JSON.parse(fs.readFileSync(${JSON.stringify(AI_DE_RECEIPT_SCHEMA)}, 'utf8'))
        validateJsonSchema(receipt, schema)
        process.stdout.write('SCHEMA_VALIDATION_PASSED')
      `
      const validator = spawn(process.execPath, ['-e', validatorSource], {
        env: { ...process.env, ORCA_RECEIPT_PATH: receiptPath }
      })
      let stdout = ''
      let stderr = ''

      validator.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      validator.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      validator.on('error', reject)
      validator.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim())
          return
        }
        reject(new Error(`${label}: AI-DE validator exited ${code}: ${stderr.trim()}`))
      })
    })
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
}

async function postExecute(port: number, request: ExecuteRequest) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  })
  return {
    status: response.status,
    receipt: await response.json()
  }
}

async function postRawExecute(port: number, body: string) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  return {
    status: response.status,
    body: await response.json()
  }
}

describe('managed execution endpoint authorization path', () => {
  beforeAll(() => {
    fs.writeFileSync(
      authorityRegistryPath,
      JSON.stringify({
        'managed-e2e-authority': {
          publicKey: keyPair.publicKey,
          revoked: false
        }
      })
    )
    process.env.ORCA_MANAGED_AUTHORITY_REGISTRY_PATH = authorityRegistryPath
    expect(isAuthorityRegistryLoaded()).toBe(true)
  })

  afterAll(() => {
    if (previousAuthorityRegistryPath === undefined) {
      delete process.env.ORCA_MANAGED_AUTHORITY_REGISTRY_PATH
    } else {
      process.env.ORCA_MANAGED_AUTHORITY_REGISTRY_PATH = previousAuthorityRegistryPath
    }
    fs.rmSync(authorityRegistryDir, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    setProcessRuntimeProfile('default')
  })

  it('executes a correctly signed envelope through the protected endpoint', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSignedRequest())
      })
      const receipt = await response.json()

      expect(response.status).toBe(200)
      expect(receipt).toMatchObject({
        schema: 'ai-de.execution-receipt/1',
        outcome: 'accepted',
        backend_kind: 'orca'
      })
      expect(receipt.error).toBeUndefined()
    } finally {
      await closeServer(server!)
    }
  })

  it('rejects malformed request shapes before issuer dereferences nullable fields', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const legacyWrapper = await postRawExecute(
        port,
        JSON.stringify({
          envelope: createSignedRequest(),
          operation_payload: createSignedRequest().payload
        })
      )
      expect(legacyWrapper.status).toBe(400)
      expect(legacyWrapper.body).toEqual({ error: { code: 'MALFORMED_REQUEST' } })

      const invalidJson = await postRawExecute(port, '{"envelope":')
      expect(invalidJson.status).toBe(400)
      expect(invalidJson.body).toEqual({ error: { code: 'MALFORMED_REQUEST' } })
    } finally {
      await closeServer(server!)
    }
  })

  it('logs the failed shape rule and layer without logging request values', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const requestId = 'shape-observability-request'
    const sensitivePayloadValue = 'must-not-appear-in-logs'

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const malformedEnvelope = createSignedRequest(requestId)
      delete (malformedEnvelope.binding as unknown as Record<string, unknown>).authority_id
      const knownRequestId = await postRawExecute(port, JSON.stringify(malformedEnvelope))
      expect(knownRequestId.status).toBe(400)

      const legacyWrapper = {
        envelope: createSignedRequest(),
        operation_payload: createSignedRequest().payload
      }
      const unavailableRequestId = await postRawExecute(port, JSON.stringify(legacyWrapper))
      expect(unavailableRequestId.status).toBe(400)

      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        `[managed-execution] Malformed request: request_id=${requestId} layer=binding field=authority_id rule=string`
      )
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        '[managed-execution] Malformed request: request_id=取得不能 layer=envelope field=binding rule=record'
      )
      const invalidJson = await postRawExecute(port, '{"envelope":')
      expect(invalidJson.status).toBe(400)
      expect(errorSpy).toHaveBeenNthCalledWith(
        3,
        '[managed-execution] Malformed request: request_id=取得不能 layer=envelope field=request rule=json'
      )
      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain(sensitivePayloadValue)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('binds the accepted effect to envelope.payload and rejects payload substitution', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: (payload) => {
        protectedEffectCalls += 1
        expect(payload).toMatchObject({ adapter: 'codex' })
      }
    })
    expect(server).not.toBeNull()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const acceptedRequest = createSignedRequest()
      const accepted = await postExecute(port, acceptedRequest)
      expect(accepted.status).toBe(200)

      const substitutedRequest = createSignedRequest()
      substitutedRequest.payload = {
        ...substitutedRequest.payload,
        case_id: 'substituted-payload'
      }
      const rejected = await postExecute(port, substitutedRequest)
      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'PAYLOAD_DIGEST_MISMATCH'
      })
      expect(protectedEffectCalls).toBe(1)
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${substitutedRequest.binding.request_id} code=PAYLOAD_DIGEST_MISMATCH layer=binding field=payload_digest rule=matches-envelope-payload`
      )
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('executes every contract-compliant operation payload through the endpoint', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()

    try {
      const port = (server!.address() as AddressInfo).port
      const requests = [
        createSignedOperationRequest('prepare', { adapter: 'codex' }, null),
        createSignedRequest(),
        createSignedOperationRequest(
          'stop',
          { mode: 'graceful', reason_code: 'USER_REQUESTED' },
          `sha256:${'1'.repeat(64)}`
        ),
        createSignedOperationRequest(
          'cleanup',
          { verification_digest: `sha256:${'2'.repeat(64)}` },
          null
        )
      ]

      for (const request of requests) {
        const response = await postExecute(port, request)
        expect(response.status).toBe(200)
        expect(response.receipt).toMatchObject({ outcome: 'accepted' })
      }
      expect(protectedEffectCalls).toBe(requests.length)
    } finally {
      await closeServer(server!)
    }
  })

  it('rejects every operation payload contract violation before the protected effect', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const port = (server!.address() as AddressInfo).port
      const cases = [
        {
          request: createSignedOperationRequest('prepare', {}, null),
          field: 'operation_payload.adapter',
          rule: 'required'
        },
        {
          request: createSignedOperationRequest(
            'start',
            {
              adapter: 'codex',
              model: { adapter: 'codex', concrete_model_id: 'gpt-5' },
              write_permission: 'workspace-write'
            },
            `sha256:${'3'.repeat(64)}`
          ),
          field: 'operation_payload.prompt',
          rule: 'required'
        },
        {
          request: createSignedOperationRequest(
            'stop',
            { mode: 'immediate' },
            `sha256:${'4'.repeat(64)}`
          ),
          field: 'operation_payload.mode',
          rule: 'enum'
        },
        {
          request: createSignedOperationRequest(
            'cleanup',
            { verification_digest: `sha256:${'5'.repeat(64)}`, extra: true },
            null
          ),
          field: 'operation_payload.extra',
          rule: 'unexpected'
        }
      ]

      for (const testCase of cases) {
        const response = await postExecute(port, testCase.request)
        expect(response.status).toBe(400)
        expect(response.receipt).toMatchObject({
          outcome: 'rejected',
          reject_reason: 'INVALID_OPERATION_PAYLOAD'
        })
        expect(errorSpy).toHaveBeenCalledWith(
          `[managed-execution] Request rejected: request_id=${testCase.request.binding.request_id} code=INVALID_OPERATION_PAYLOAD layer=payload field=${testCase.field} rule=${testCase.rule}`
        )
      }
      expect(protectedEffectCalls).toBe(0)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('validates the endpoint-generated orca receipts for all three outcomes with AI-DE', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const acceptedRequest = createSignedRequest()
      const accepted = await postExecute(port, acceptedRequest)
      expect(accepted.status).toBe(200)
      expect(accepted.receipt).toMatchObject({
        schema: 'ai-de.execution-receipt/1',
        outcome: 'accepted',
        backend_kind: 'orca'
      })
      const acceptedValidation = await validateWithAiDe(accepted.receipt, 'accepted-orca')

      const replayed = await postExecute(port, acceptedRequest)
      expect(replayed.status).toBe(200)
      expect(replayed.receipt).toEqual({ ...accepted.receipt, outcome: 'replayed' })
      const replayedValidation = await validateWithAiDe(replayed.receipt, 'replayed-orca')

      const rejectedRequest = createSignedRequest()
      rejectedRequest.signature.value = 'b'.repeat(128)
      const rejected = await postExecute(port, rejectedRequest)
      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        schema: 'ai-de.execution-receipt/1',
        outcome: 'rejected',
        backend_kind: 'orca',
        reject_reason: 'INVALID_SIGNATURE'
      })
      const rejectedValidation = await validateWithAiDe(rejected.receipt, 'rejected-orca')

      console.log(
        `[AI-DE validator] accepted=${acceptedValidation}; replayed=${replayedValidation}; rejected=${rejectedValidation}`
      )
    } finally {
      await closeServer(server!)
    }
  })

  it('replays the stored receipt without a second effect and denies a different payload', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const acceptedRequest = createSignedRequest()
      const accepted = await postExecute(port, acceptedRequest)
      expect(accepted.status).toBe(200)

      const replayed = await postExecute(port, acceptedRequest)
      expect(replayed.status).toBe(200)
      expect(replayed.receipt).toEqual({ ...accepted.receipt, outcome: 'replayed' })

      const differentPayload = createSignedRequest(
        acceptedRequest.binding.request_id,
        '-different-payload'
      )
      const rejected = await postExecute(port, differentPayload)
      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD'
      })
      expect(protectedEffectCalls).toBe(1)
    } finally {
      await closeServer(server!)
    }
  })

  it('returns the original receipt for an expired known request without rerunning the effect', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const initialTime = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(initialTime)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const acceptedRequest = createSignedRequest()
      const accepted = await postExecute(port, acceptedRequest)
      expect(accepted.status).toBe(200)
      expect(accepted.receipt.outcome).toBe('accepted')

      vi.setSystemTime(initialTime + 120_000)
      const replayed = await postExecute(port, acceptedRequest)

      expect(replayed.status).toBe(200)
      expect(replayed.receipt).toEqual({ ...accepted.receipt, outcome: 'replayed' })
      expect(replayed.receipt.backend_session_id).toBe(accepted.receipt.backend_session_id)
      expect(replayed.receipt.accepted_at).toBe(accepted.receipt.accepted_at)
      expect(protectedEffectCalls).toBe(1)
    } finally {
      await closeServer(server!)
    }
  })

  it('rejects an expired unknown request before starting the effect', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const initialTime = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(initialTime)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const expiredRequest = createSignedRequest()
      vi.setSystemTime(initialTime + 120_000)
      const rejected = await postExecute(port, expiredRequest)

      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'EXPIRED_REQUEST'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${expiredRequest.binding.request_id} code=EXPIRED_REQUEST layer=envelope field=expires_at rule=not-expired`
      )
      expect(protectedEffectCalls).toBe(0)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('rejects an invalid signature before expiry for an expired envelope and records its reason', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const initialTime = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(initialTime)

    let protectedEffectCalls = 0
    const server = await startManagedExecutionEndpoint({
      port: 0,
      onProtectedEffect: () => {
        protectedEffectCalls += 1
      }
    })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port

      const invalidRequest = createSignedRequest()
      invalidRequest.signature.value = 'b'.repeat(128)
      vi.setSystemTime(initialTime + 120_000)
      const rejected = await postExecute(port, invalidRequest)

      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'INVALID_SIGNATURE'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${invalidRequest.binding.request_id} code=INVALID_SIGNATURE layer=signature field=value rule=ed25519-verification`
      )
      expect(protectedEffectCalls).toBe(0)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })
})
