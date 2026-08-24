import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import * as fs from 'node:fs'
import type { Server } from 'node:http'
import { createConnection, type AddressInfo, type Socket } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { isAuthorityRegistryLoaded } from '../authority-registry'
import { canonicalBytes } from '../canonical'
import { startManagedExecutionEndpoint, type StoredAcceptedReceipt } from './managed-execution-test-endpoint'
import { ManagedExecutionReceiptStore } from '../managed-execution-receipt-store'
import { MAX_MANAGED_EXECUTION_BODY_BYTES } from '../request-body-reader'
import {
  EXECUTION_REQUEST_BINDING_PAYLOAD_EQUIVALENCE_FIELDS,
  EXECUTION_REQUEST_CONTRACT_VERSIONS,
  type ExecutionOperation
} from '../execution-request-contract'
import type { ExecuteRequest } from '../issuer'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'
import { validateReceiptWithAiDe } from './ai-de-receipt-contract'
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
  operationPayload: Record<string, unknown>,
  launchPlanDigest: string | null,
  requestId: string = randomUUID()
): ExecuteRequest {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 60_000)
  const payload = {
    schema: 'ai-de.execution-request/1',
    operation,
    request_id: requestId,
    case_id: 'managed-e2e-case',
    task_id: 'managed-e2e-task',
    attempt_id: 'managed-e2e-attempt',
    packet_digest: `sha256:${'0'.repeat(64)}`,
    launch_plan_digest: launchPlanDigest,
    ...EXECUTION_REQUEST_CONTRACT_VERSIONS,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    operation_payload: operationPayload
  }
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

function withResignedPayloadMismatch(
  request: ExecuteRequest,
  field: (typeof EXECUTION_REQUEST_BINDING_PAYLOAD_EQUIVALENCE_FIELDS)[number]
): ExecuteRequest {
  const payload = {
    ...request.payload,
    [field]: field === 'launch_plan_digest' ? `sha256:${'1'.repeat(64)}` : `mismatched-${field}`
  }
  const binding = { ...request.binding, payload_digest: sha256Canonical(payload) }
  const signature = sign(
    null,
    canonicalBytes({
      binding,
      issued_at: request.issued_at,
      expires_at: request.expires_at
    }),
    keyPair.privateKey
  )

  return {
    ...request,
    signature: { ...request.signature, value: signature.toString('hex') },
    binding,
    payload
  }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function validateWithAiDe(receipt: unknown): string {
  const result = validateReceiptWithAiDe(receipt)
  if (!result.valid) {
    throw new Error(`AI-DE receipt contract rejected receipt: ${result.output}`)
  }
  return result.output
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

function connectToEndpoint(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function writeRequest(socket: Socket, body: string): void {
  socket.write(
    `POST /execute HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Condition was not met before timeout')
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

  it('rejects an oversized pre-authorization body and records only its classification', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const port = (server!.address() as AddressInfo).port
      const response = await postRawExecute(port, 'x'.repeat(MAX_MANAGED_EXECUTION_BODY_BYTES + 1))

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: { code: 'MALFORMED_REQUEST' } })
      expect(errorSpy).toHaveBeenCalledWith(
        '[managed-execution] Malformed request: request_id=取得不能 layer=transport field=body rule=maximum-bytes'
      )
      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('x'.repeat(128))
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('does not reject a contract-maximum escaped prompt body by maximum bytes', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const port = (server!.address() as AddressInfo).port
      const escapedContractMaximumPrompt = '\\ud83d\\ude00'.repeat(262_144)
      const body = `{"prompt":"${escapedContractMaximumPrompt}"}`
      expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(3_145_730)

      const response = await postRawExecute(port, body)

      expect(response.status).toBe(400)
      expect(errorSpy).not.toHaveBeenCalledWith(
        '[managed-execution] Malformed request: request_id=取得不能 layer=transport field=body rule=maximum-bytes'
      )
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('rejects a stalled body read and records its timeout classification', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const server = await startManagedExecutionEndpoint({ port: 0, bodyReadTimeoutMs: 30 })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const port = (server!.address() as AddressInfo).port
      const socket = await connectToEndpoint(port)
      let response = ''
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8')
      })
      socket.write(
        'POST /execute HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1\r\n\r\n'
      )

      await waitFor(() => response.includes('400 Bad Request'))
      expect(errorSpy).toHaveBeenCalledWith(
        '[managed-execution] Malformed request: request_id=取得不能 layer=transport field=body rule=read-timeout'
      )
      socket.destroy()
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('keeps a response socket alive while the protected effect outlasts body ingress', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const server = await startManagedExecutionEndpoint({
      port: 0,
      bodyReadTimeoutMs: 30,
      onProtectedEffect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
    })
    expect(server).not.toBeNull()

    try {
      const port = (server!.address() as AddressInfo).port
      const response = await postExecute(port, createSignedRequest())

      expect(response.status).toBe(200)
      expect(response.receipt).toMatchObject({ outcome: 'accepted' })
    } finally {
      await closeServer(server!)
    }
  })

  it('records an aborted TCP body without writing to the closed socket', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const port = (server!.address() as AddressInfo).port
      const socket = await connectToEndpoint(port)
      socket.write(
        'POST /execute HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{'
      )
      await new Promise((resolve) => setImmediate(resolve))
      socket.destroy()

      await waitFor(() =>
        errorSpy.mock.calls.some(
          ([message]) =>
            message ===
            '[managed-execution] Malformed request: request_id=取得不能 layer=transport field=connection rule=client-aborted'
        )
      )
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })

  it('replays the first receipt after a client disconnects on the real TCP endpoint', async () => {
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
      const request = createSignedRequest()
      const socket = await connectToEndpoint(port)
      writeRequest(socket, JSON.stringify(request))
      await waitFor(() => protectedEffectCalls === 1)
      socket.destroy()

      const replayed = await postExecute(port, request)
      expect(replayed.status).toBe(200)
      expect(replayed.receipt).toMatchObject({ outcome: 'replayed' })
      expect(protectedEffectCalls).toBe(1)
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
        expect(payload.operation_payload).toMatchObject({ adapter: 'codex' })
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

  it.each(EXECUTION_REQUEST_BINDING_PAYLOAD_EQUIVALENCE_FIELDS)(
    'rejects a re-signed binding and payload mismatch for %s before the protected effect',
    async (field) => {
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
      const request = withResignedPayloadMismatch(createSignedRequest(), field)
      const response = await postExecute(port, request)

      expect(response.status).toBe(400)
      expect(response.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'BINDING_PAYLOAD_MISMATCH'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${request.binding.request_id} code=BINDING_PAYLOAD_MISMATCH layer=binding field=/payload/${field} rule=matches-binding`
      )
      expect(protectedEffectCalls).toBe(0)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
    }
  )

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
      const acceptedValidation = validateWithAiDe(accepted.receipt)

      const replayed = await postExecute(port, acceptedRequest)
      expect(replayed.status).toBe(200)
      expect(replayed.receipt).toEqual({ ...accepted.receipt, outcome: 'replayed' })
      const replayedValidation = validateWithAiDe(replayed.receipt)

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
      const rejectedValidation = validateWithAiDe(rejected.receipt)

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
      receiptStore: new ManagedExecutionReceiptStore<StoredAcceptedReceipt>(1),
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

      const newRequest = createSignedRequest()
      const capacityRejected = await postExecute(port, newRequest)
      expect(capacityRejected.status).toBe(400)
      expect(capacityRejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'RECEIPT_STORE_CAPACITY_EXCEEDED'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${newRequest.binding.request_id} code=RECEIPT_STORE_CAPACITY_EXCEEDED layer=receipt-store field=completed_receipts rule=max-entries`
      )
      expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('managed-e2e-case')
      expect(protectedEffectCalls).toBe(1)
    } finally {
      errorSpy.mockRestore()
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
