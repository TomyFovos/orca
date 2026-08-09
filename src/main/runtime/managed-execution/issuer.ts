import { verifyEd25519Signature } from './crypto'
import { lookupAuthority } from './authority-registry'
import {
  mintManagedExecutionAuthorization,
  type ExternalControlPlaneAuthorityBinding,
  type ManagedExecutionAuthorization
} from './authorization'
import { createHash } from 'node:crypto'
import { canonicalBytes } from './canonical'

const MAX_EXPIRY_DURATION_MS = 5 * 60 * 1000 // 5分
const MAX_CLOCK_SKEW_MS = 60 * 1000 // 1分

type MintedRequest = {
  request_id: string
  expires_at: string
  bindingCanonical: string
}

const mintedRequests = new Map<string, MintedRequest>()

export type SignedEnvelope = {
  schema: 'ai-de.execution-envelope/1'
  signature: {
    algorithm: 'ed25519'
    canonicalization: 'RFC8785-JCS'
    value: string // 128 文字の hex (64 バイト)
  }
  binding: ExternalControlPlaneAuthorityBinding
  payload: Record<string, unknown>
  issued_at: string
  expires_at: string
}

/** The execution endpoint accepts the signed envelope as its complete request. */
export type ExecuteRequest = SignedEnvelope

export enum IssuerErrorCode {
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  UNKNOWN_AUTHORITY_ID = 'UNKNOWN_AUTHORITY_ID',
  REVOKED_AUTHORITY = 'REVOKED_AUTHORITY',
  EXPIRED_REQUEST = 'EXPIRED_REQUEST',
  FUTURE_ISSUED_AT = 'FUTURE_ISSUED_AT',
  INVALID_BINDING = 'INVALID_BINDING',
  PAYLOAD_DIGEST_MISMATCH = 'PAYLOAD_DIGEST_MISMATCH',
  REPLAY_ATTACK = 'REPLAY_ATTACK',
  REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD = 'REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  MALFORMED_REQUEST = 'MALFORMED_REQUEST'
}

export type IssuerRejectionDetail = Readonly<{
  layer: string
  field: string
  rule: string
}>

export class IssuerError extends Error {
  constructor(
    public readonly code: IssuerErrorCode,
    message: string,
    public readonly detail: IssuerRejectionDetail
  ) {
    super(message)
    this.name = 'IssuerError'
  }
}

export function mintAuthorization(envelope: ExecuteRequest): ManagedExecutionAuthorization {
  cleanupExpiredRequests()

  // 1. authority_id を registry と照合（署名検証より先）
  const authorityInfo = lookupAuthority(envelope.binding.authority_id)
  if (!authorityInfo) {
    throw new IssuerError(IssuerErrorCode.UNKNOWN_AUTHORITY_ID, 'Unknown authority_id', {
      layer: 'authority',
      field: 'authority_id',
      rule: 'registry-membership'
    })
  }

  // 1.5. authority_id が失効していないか確認
  if (authorityInfo.revoked) {
    throw new IssuerError(IssuerErrorCode.REVOKED_AUTHORITY, 'Authority is revoked', {
      layer: 'authority',
      field: 'authority_id',
      rule: 'not-revoked'
    })
  }

  // 2. Ed25519 署名を検証（公開鍵を渡す）
  if (!verifyEd25519Signature(envelope, authorityInfo.publicKey)) {
    throw new IssuerError(IssuerErrorCode.INVALID_SIGNATURE, 'Invalid signature', {
      layer: 'signature',
      field: 'value',
      rule: 'ed25519-verification'
    })
  }

  // 3. operation を検証
  const validOperations = ['prepare', 'start', 'stop', 'cleanup']
  if (!validOperations.includes(envelope.binding.operation)) {
    throw new IssuerError(
      IssuerErrorCode.UNSUPPORTED_OPERATION,
      `Unsupported operation: ${envelope.binding.operation}`,
      {
        layer: 'binding',
        field: 'operation',
        rule: 'supported-operation'
      }
    )
  }

  // 4. タイムスタンプを検証（envelope 直下の issued_at/expires_at）
  validateTimestamps(envelope.issued_at, envelope.expires_at)

  // 5. binding 11フィールドを検証
  validateBinding(envelope.binding)

  // 6. payload_digest で envelope.payload の照合
  if (!verifyPayloadDigest(envelope)) {
    throw new IssuerError(IssuerErrorCode.PAYLOAD_DIGEST_MISMATCH, 'payload_digest mismatch', {
      layer: 'binding',
      field: 'payload_digest',
      rule: 'matches-envelope-payload'
    })
  }

  // 7. request_id の単回使用を検証（リプレイ防御）
  const bindingCanonical = canonicalBytes(envelope.binding).toString('utf8')
  const existingRequest = mintedRequests.get(envelope.binding.request_id)
  if (existingRequest) {
    if (existingRequest.bindingCanonical !== bindingCanonical) {
      throw new IssuerError(
        IssuerErrorCode.REQUEST_ID_REUSED_WITH_DIFFERENT_PAYLOAD,
        'request_id was reused with different payload',
        {
          layer: 'binding',
          field: 'request_id',
          rule: 'same-binding'
        }
      )
    }
    logReplayAttempt(envelope.binding.request_id)
    throw new IssuerError(IssuerErrorCode.REPLAY_ATTACK, 'request_id already used', {
      layer: 'binding',
      field: 'request_id',
      rule: 'single-use'
    })
  }

  // 8. capability を mint
  const authorization = mintManagedExecutionAuthorization()

  // 9. request_id を記録
  mintedRequests.set(envelope.binding.request_id, {
    request_id: envelope.binding.request_id,
    expires_at: envelope.expires_at,
    bindingCanonical
  })

  return authorization
}

function cleanupExpiredRequests() {
  const now = Date.now()
  for (const [requestId, request] of mintedRequests.entries()) {
    if (new Date(request.expires_at).getTime() < now) {
      mintedRequests.delete(requestId)
    }
  }
}

function validateTimestamps(issued_at: string, expires_at: string) {
  const now = Date.now()
  const issuedAt = new Date(issued_at).getTime()
  const expiresAt = new Date(expires_at).getTime()

  if (issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throw new IssuerError(IssuerErrorCode.FUTURE_ISSUED_AT, 'issued_at is too far in the future', {
      layer: 'envelope',
      field: 'issued_at',
      rule: 'within-clock-skew'
    })
  }

  if (expiresAt < now) {
    throw new IssuerError(IssuerErrorCode.EXPIRED_REQUEST, 'expires_at is in the past', {
      layer: 'envelope',
      field: 'expires_at',
      rule: 'not-expired'
    })
  }

  const duration = expiresAt - issuedAt
  if (duration > MAX_EXPIRY_DURATION_MS) {
    throw new IssuerError(
      IssuerErrorCode.EXPIRED_REQUEST,
      'expires_at exceeds maximum allowed duration',
      {
        layer: 'envelope',
        field: 'expires_at',
        rule: 'maximum-duration'
      }
    )
  }
}

function validateBinding(binding: ExternalControlPlaneAuthorityBinding) {
  const requiredFields = [
    'authority_id',
    'operation',
    'request_id',
    'case_id',
    'task_id',
    'attempt_id',
    'packet_digest',
    'launch_plan_digest',
    'payload_digest',
    'protocol_version',
    'schema_version'
  ]

  for (const field of requiredFields) {
    if (!(field in binding)) {
      throw new IssuerError(IssuerErrorCode.INVALID_BINDING, `Missing field: ${field}`, {
        layer: 'binding',
        field,
        rule: 'required'
      })
    }
  }
}

function verifyPayloadDigest(envelope: SignedEnvelope): boolean {
  const payloadBytes = canonicalBytes(envelope.payload)
  const calculatedDigest = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`
  return calculatedDigest === envelope.binding.payload_digest
}

function logReplayAttempt(request_id: string) {
  console.error(`[managed-execution] Replay attempt detected: request_id=${request_id}`)
}
