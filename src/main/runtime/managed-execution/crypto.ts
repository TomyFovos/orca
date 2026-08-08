import { createPublicKey, verify } from 'node:crypto'
import type { SignedEnvelope } from './issuer'
import { canonicalBytes } from './canonical'

/**
 * Ed25519 署名を検証する
 *
 * @param envelope - 検証対象の署名付きエンベロープ
 * @param publicKeyPem - PEM 形式の Ed25519 公開鍵
 * @returns 署名が有効な場合は true、それ以外は false
 */
export function verifyEd25519Signature(envelope: SignedEnvelope, publicKeyPem: string): boolean {
  try {
    // signature.value は 128 文字の hex (64 バイト)
    if (!envelope.signature.value || envelope.signature.value.length !== 128) {
      return false
    }

    // binding と有効期間を RFC8785-JCS で正規化（AI-DE と同一実装）
    const preimageBytes = canonicalBytes({
      binding: envelope.binding,
      issued_at: envelope.issued_at,
      expires_at: envelope.expires_at
    })

    // 署名を hex からデコード
    const signatureBuffer = Buffer.from(envelope.signature.value, 'hex')

    // Ed25519 署名の長さは 64 バイト
    if (signatureBuffer.length !== 64) {
      return false
    }

    // 公開鍵を PEM から読み込み
    const publicKey = createPublicKey(publicKeyPem)

    // Ed25519 署名を検証
    const isValid = verify(null, preimageBytes, publicKey, signatureBuffer)

    return isValid
  } catch {
    // 検証失敗は false を返す（fail-closed）
    return false
  }
}
