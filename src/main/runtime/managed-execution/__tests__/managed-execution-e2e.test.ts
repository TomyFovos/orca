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
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 60_000)
  const payload = {
    case_id: `managed-e2e-case${payloadSuffix}`,
    task_id: `managed-e2e-task${payloadSuffix}`,
    attempt_id: `managed-e2e-attempt${payloadSuffix}`,
    packet_digest: `sha256:${'0'.repeat(64)}`
  }
  const binding = {
    authority_id: 'managed-e2e-authority',
    request_id: requestId,
    case_id: payload.case_id,
    task_id: payload.task_id,
    attempt_id: payload.attempt_id,
    packet_digest: payload.packet_digest,
    launch_plan_digest: null,
    operation: 'start',
    payload_digest: sha256Canonical(payload),
    protocol_version: 'ai-de-trusted-launcher/1',
    schema_version: 'execution-envelope-1'
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
      onProtectedEffect: (envelope) => {
        protectedEffectCalls += 1
        expect(envelope.payload).toMatchObject({ case_id: 'managed-e2e-case' })
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
})
