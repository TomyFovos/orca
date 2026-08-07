import { describe, test, expect, beforeEach, vi } from 'vitest'
import { mintAuthorization, IssuerError, IssuerErrorCode, type ExecuteRequest } from '../issuer'
import { getAuthorityRegistry } from '../authority-registry'
import * as crypto from 'node:crypto'

// モック
vi.mock('../authority-registry', () => ({
  getAuthorityRegistry: vi.fn()
}))

vi.mock('../crypto', () => ({
  verifyEd25519Signature: vi.fn()
}))

import { verifyEd25519Signature } from '../crypto'

const mockRegistry = vi.mocked(getAuthorityRegistry)
const mockVerifySignature = vi.mocked(verifyEd25519Signature)

function createValidRequest(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 60 * 1000) // 1分後

  const operation_payload = {
    case_id: 'test-case',
    task_id: 'test-task',
    attempt_id: 'test-attempt',
    packet_digest: `sha256:${'0'.repeat(64)}`
  }

  const payloadBytes = Buffer.from(JSON.stringify(operation_payload))
  const payloadDigest = `sha256:${crypto.createHash('sha256').update(payloadBytes).digest('hex')}`

  return {
    envelope: {
      schema: 'ai-de.execution-envelope/1',
      signature: {
        algorithm: 'ed25519',
        canonicalization: 'RFC8785-JCS',
        value: 'a'.repeat(128) // 64 バイトの hex
      },
      binding: {
        authority_id: 'test-authority',
        operation: 'prepare',
        request_id: `test-request-${Math.random()}`,
        case_id: 'test-case',
        task_id: 'test-task',
        attempt_id: 'test-attempt',
        packet_digest: `sha256:${'0'.repeat(64)}`,
        launch_plan_digest: `sha256:${'1'.repeat(64)}`,
        payload_digest: payloadDigest,
        protocol_version: '1',
        schema_version: '1'
      },
      payload: operation_payload,
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    },
    operation_payload,
    ...overrides
  }
}

describe('issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegistry.mockReturnValue(
      new Map([['test-authority', { publicKey: 'test-public-key', revoked: false }]])
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
    request.envelope.binding.authority_id = 'unknown-authority'
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.UNKNOWN_AUTHORITY_ID)
    }
  })

  test('負試験3: expires_at 期限切れ → EXPIRED_REQUEST', () => {
    const request = createValidRequest()
    const past = new Date(Date.now() - 60 * 1000) // 1分前
    request.envelope.expires_at = past.toISOString()
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
    request.envelope.binding.payload_digest = `sha256:${'f'.repeat(64)}` // 不正な digest
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.PAYLOAD_DIGEST_MISMATCH)
    }
  })

  test('負試験5: binding 欠落 → INVALID_BINDING', () => {
    const request = createValidRequest()
    delete (request.envelope.binding as unknown as Record<string, unknown>).case_id
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
    request.envelope.issued_at = future.toISOString()
    expect(() => mintAuthorization(request)).toThrow(IssuerError)
    try {
      mintAuthorization(request)
    } catch (error) {
      expect(error).toBeInstanceOf(IssuerError)
      expect((error as IssuerError).code).toBe(IssuerErrorCode.FUTURE_ISSUED_AT)
    }
  })
})
