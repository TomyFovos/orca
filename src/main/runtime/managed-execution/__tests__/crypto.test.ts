import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyEd25519Signature } from '../crypto'
import { canonicalBytes } from '../canonical'
import type { SignedEnvelope } from '../issuer'

describe('verifyEd25519Signature (実鍵テスト)', () => {
  let keyPair: { publicKey: string; privateKey: string }
  let anotherKeyPair: { publicKey: string; privateKey: string }

  beforeAll(() => {
    // Ed25519 鍵ペアを生成
    keyPair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    anotherKeyPair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
  })

  function createValidEnvelope(): SignedEnvelope {
    const binding = {
      authority_id: 'test-authority',
      operation: 'start',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      case_id: 'case-001',
      task_id: 'task-001',
      attempt_id: 'attempt-001',
      packet_digest: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      launch_plan_digest: null,
      payload_digest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      protocol_version: 'ai-de-trusted-launcher/1',
      schema_version: 'execution-envelope-1'
    }

    // binding を RFC8785-JCS で正規化して署名（AI-DE と同一実装）
    const bindingBytes = canonicalBytes(binding)
    const signature = sign(null, bindingBytes, keyPair.privateKey)

    return {
      schema: 'ai-de.execution-envelope/1',
      signature: {
        algorithm: 'ed25519',
        canonicalization: 'RFC8785-JCS',
        value: signature.toString('hex')
      },
      binding,
      payload: {},
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString()
    }
  }

  it('実際の鍵ペアで署名した envelope は受理される', () => {
    const envelope = createValidEnvelope()
    const isValid = verifyEd25519Signature(envelope, keyPair.publicKey)
    expect(isValid).toBe(true)
  })

  it('正しい署名だが、binding を1バイト改竄すると拒否される', () => {
    const envelope = createValidEnvelope()

    // binding の1フィールドを改竄
    const tamperedEnvelope: SignedEnvelope = {
      ...envelope,
      binding: {
        ...envelope.binding,
        request_id: '550e8400-e29b-41d4-a716-446655440001' // 最後の文字を変更
      }
    }

    const isValid = verifyEd25519Signature(tamperedEnvelope, keyPair.publicKey)
    expect(isValid).toBe(false)
  })

  it('別の鍵ペアで署名した envelope は拒否される', () => {
    const envelope = createValidEnvelope()

    // anotherKeyPair の公開鍵で検証（異なる鍵）
    const isValid = verifyEd25519Signature(envelope, anotherKeyPair.publicKey)
    expect(isValid).toBe(false)
  })

  it('署名フィールドを空／不正な長さにすると拒否される', () => {
    const envelope = createValidEnvelope()

    // 空の署名
    envelope.signature.value = ''
    expect(verifyEd25519Signature(envelope, keyPair.publicKey)).toBe(false)

    // 短すぎる署名（64 バイト未満）
    envelope.signature.value = 'a'.repeat(64) // 32 バイト
    expect(verifyEd25519Signature(envelope, keyPair.publicKey)).toBe(false)

    // 長すぎる署名（64 バイト超）
    envelope.signature.value = 'a'.repeat(256) // 128 バイト
    expect(verifyEd25519Signature(envelope, keyPair.publicKey)).toBe(false)

    // 不正な文字（hex ではない）
    envelope.signature.value = 'g'.repeat(128) // hex でない文字
    expect(verifyEd25519Signature(envelope, keyPair.publicKey)).toBe(false)
  })
})
