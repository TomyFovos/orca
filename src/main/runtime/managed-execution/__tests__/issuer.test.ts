import { describe, test, expect, beforeEach, vi } from 'vitest'
import { mintAuthorization, IssuerError, IssuerErrorCode, type ExecuteRequest } from '../issuer'
import { lookupAuthority } from '../authority-registry'
import { canonicalBytes } from '../canonical'
import { EXECUTION_REQUEST_CONTRACT_VERSIONS } from '../execution-request-contract'
import * as crypto from 'node:crypto'

// モック
vi.mock('../authority-registry', () => ({
  lookupAuthority: vi.fn()
}))

vi.mock('../crypto', () => ({
  verifyEd25519Signature: vi.fn()
}))

import { verifyEd25519Signature } from '../crypto'

const mockLookupAuthority = vi.mocked(lookupAuthority)
const mockVerifySignature = vi.mocked(verifyEd25519Signature)

function createValidRequest(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 60 * 1000) // 1分後
  const requestId = `test-request-${Math.random()}`
  const launchPlanDigest = `sha256:${'1'.repeat(64)}`

  const payload = {
    schema: 'ai-de.execution-request/1',
    operation: 'start',
    request_id: requestId,
    case_id: 'test-case',
    task_id: 'test-task',
    attempt_id: 'test-attempt',
    packet_digest: `sha256:${'0'.repeat(64)}`,
    launch_plan_digest: launchPlanDigest,
    ...EXECUTION_REQUEST_CONTRACT_VERSIONS,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    operation_payload: {
      adapter: 'codex',
      model: { adapter: 'codex', concrete_model_id: 'gpt-5' },
      write_permission: 'workspace-write',
      prompt: ''
    }
  }

  const payloadBytes = canonicalBytes(payload)
  const payloadDigest = `sha256:${crypto.createHash('sha256').update(payloadBytes).digest('hex')}`

  return {
    schema: 'ai-de.execution-envelope/1',
    signature: {
      algorithm: 'ed25519',
      canonicalization: 'RFC8785-JCS',
      value: 'a'.repeat(128) // 64 バイトの hex
    },
    binding: {
      authority_id: 'test-authority',
      operation: 'start',
      request_id: requestId,
      case_id: 'test-case',
      task_id: 'test-task',
      attempt_id: 'test-attempt',
      packet_digest: `sha256:${'0'.repeat(64)}`,
      launch_plan_digest: launchPlanDigest,
      payload_digest: payloadDigest,
      ...EXECUTION_REQUEST_CONTRACT_VERSIONS
    },
    payload,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ...overrides
  }
}

function withPayloadDigest(request: ExecuteRequest, payload: Record<string, unknown>): ExecuteRequest {
  const payloadDigest = `sha256:${crypto
    .createHash('sha256')
    .update(canonicalBytes(payload))
    .digest('hex')}`
  return {
    ...request,
    binding: { ...request.binding, payload_digest: payloadDigest },
    payload
  }
}

describe('issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLookupAuthority.mockImplementation((authorityId) =>
      authorityId === 'test-authority'
        ? { publicKey: 'test-public-key', revoked: false }
        : undefined
    )
    mockVerifySignature.mockReturnValue(true)
  })

  test('正常系: 有効な envelope で capability が mint される', () => {
    const request = createValidRequest()
    const authorization = mintAuthorization(request)
    expect(authorization).toBeDefined()
  })

  test('負試験1: 署名不正 → INVALID_SIGNATURE', () => {
    mockVerifySignature.mockReturnValue(false)
    const request = createValidRequest()
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    expect(() => mintAuthorization(request)).toThrowError(/Invalid signature/)
  })

  test('負試験2: authority_id 未登録 → UNKNOWN_AUTHORITY_ID', () => {
    const request = createValidRequest()
    const tamperedRequest: ExecuteRequest = {
      ...request,
      binding: { ...request.binding, authority_id: 'unknown-authority' }
    }
    expect(() => mintAuthorization(tamperedRequest)).toThrow(IssuerError)
    try {
      mintAuthorization(tamperedRequest)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.UNKNOWN_AUTHORITY_ID)
    }
  })

  test('負試験3: expires_at 期限切れ → EXPIRED_REQUEST', () => {
    const request = createValidRequest()
    const past = new Date(Date.now() - 60 * 1000) // 1分前
    request.expires_at = past.toISOString()
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.EXPIRED_REQUEST)
    }
  })

  test('負試験4: payload_digest 不一致 → PAYLOAD_DIGEST_MISMATCH', () => {
    const request = createValidRequest()
    const tamperedRequest: ExecuteRequest = {
      ...request,
      binding: {
        ...request.binding,
        payload_digest: `sha256:${'f'.repeat(64)}` // 不正な digest
      }
    }
    expect(() => mintAuthorization(tamperedRequest)).toThrow(IssuerError)
    try {
      mintAuthorization(tamperedRequest)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.PAYLOAD_DIGEST_MISMATCH)
    }
  })

  test('負試験5: binding 欠落 → INVALID_BINDING', () => {
    const request = createValidRequest()
    delete (request.binding as unknown as Record<string, unknown>).case_id
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.INVALID_BINDING)
    }
  })

  test('負試験6: request_id 重複（リプレイ）→ REPLAY_ATTACK', () => {
    const request = createValidRequest()
    // 1回目は成功
    mintAuthorization(request)
    // 2回目は失敗
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.REPLAY_ATTACK)
    }
  })

  test('負試験7: issued_at が未来すぎる（1分超）→ FUTURE_ISSUED_AT', () => {
    const request = createValidRequest()
    const future = new Date(Date.now() + 2 * 60 * 1000) // 2分後
    request.issued_at = future.toISOString()
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.FUTURE_ISSUED_AT)
    }
  })

  test('負試験8: request root の operation_payload 欠落 → INVALID_OPERATION_PAYLOAD', () => {
    const request = createValidRequest()
    const payload = { ...request.payload }
    delete payload.operation_payload
    const malformedRequest = withPayloadDigest(request, payload)

    expect(() => mintAuthorization(malformedRequest)).toThrow(IssuerError)
    try {
      mintAuthorization(malformedRequest)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.INVALID_OPERATION_PAYLOAD)
      expect((error as IssuerError).detail).toEqual({
        layer: 'payload',
        field: 'operation_payload',
        rule: 'required'
      })
    }
  })
})
