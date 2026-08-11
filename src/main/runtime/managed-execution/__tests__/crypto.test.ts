import { describe, it, expect, beforeAll } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { verifyEd25519Signature } from '../crypto'
import { canonicalBytes } from '../canonical'
import { EXECUTION_REQUEST_CONTRACT_VERSIONS } from '../execution-request-contract'
import type { SignedEnvelope } from '../issuer'

type SignatureVector = {
  envelope: SignedEnvelope
  signing_key: {
    public_key_spki_base64: string
  }
  expected: {
    canonical_preimage_utf8: string
    canonical_preimage_hex: string
    canonical_preimage_sha256: string
    signature_hex: string
  }
}

const vectorsPath = path.join(
  __dirname,
  'fixtures',
  'execution-envelope-signature-test-vectors.json'
)
const vectorsData = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8')) as {
  vectors: SignatureVector[]
}

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
      ...EXECUTION_REQUEST_CONTRACT_VERSIONS
    }

    const issuedAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60000).toISOString()

    // binding と有効期間を RFC8785-JCS で正規化して署名（AI-DE と同一実装）
    const preimageBytes = canonicalBytes({
      binding,
      issued_at: issuedAt,
      expires_at: expiresAt
    })
    const signature = sign(null, preimageBytes, keyPair.privateKey)

    return {
      schema: 'ai-de.execution-envelope/1',
      signature: {
        algorithm: 'ed25519',
        canonicalization: 'RFC8785-JCS',
        value: signature.toString('hex')
      },
      binding,
      payload: {},
      issued_at: issuedAt,
      expires_at: expiresAt
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

  it('署名後に expires_at を改竄すると拒否される', () => {
    const envelope = createValidEnvelope()
    envelope.expires_at = new Date(Date.parse(envelope.expires_at) + 60000).toISOString()

    const isValid = verifyEd25519Signature(envelope, keyPair.publicKey)
    expect(isValid).toBe(false)
  })

  it('署名後に issued_at を改竄すると拒否される', () => {
    const envelope = createValidEnvelope()
    envelope.issued_at = new Date(Date.parse(envelope.issued_at) - 60000).toISOString()

    const isValid = verifyEd25519Signature(envelope, keyPair.publicKey)
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

  it('AI-DE 共有署名ベクタの preimage・digest・署名を再現して検証できる', () => {
    const vector = vectorsData.vectors[0]
    const preimageBytes = canonicalBytes({
      binding: vector.envelope.binding,
      issued_at: vector.envelope.issued_at,
      expires_at: vector.envelope.expires_at
    })
    const publicKey = createPublicKey({
      key: Buffer.from(vector.signing_key.public_key_spki_base64, 'base64'),
      format: 'der',
      type: 'spki'
    })

    expect(preimageBytes.toString('utf8')).toBe(vector.expected.canonical_preimage_utf8)
    expect(preimageBytes.toString('hex')).toBe(vector.expected.canonical_preimage_hex)
    expect(createHash('sha256').update(preimageBytes).digest('hex')).toBe(
      vector.expected.canonical_preimage_sha256
    )
    expect(vector.envelope.signature.value).toBe(vector.expected.signature_hex)
    expect(
      verifyEd25519Signature(
        vector.envelope,
        publicKey.export({ format: 'pem', type: 'spki' }).toString()
      )
    ).toBe(true)
  })
})
