import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { getProcessRuntimeProfile, MANAGED_ORCA_RUNTIME_PROFILE } from '../runtime-profile'
import { isAuthorityRegistryLoaded } from './authority-registry'
import { mintAuthorization, IssuerError, IssuerErrorCode, type ExecuteRequest } from './issuer'
import { assertManagedExecutionAuthorized } from './authorization'
import { RequestBodyReadError, readManagedExecutionRequestBody } from './request-body-reader'
import { ManagedExecutionReceiptStore } from './managed-execution-receipt-store'
import {
  applyManagedExecutionTimeouts,
  resolveManagedExecutionBodyReadTimeout
} from './endpoint-timeouts'
import {
  DEFAULT_MANAGED_EXECUTION_HOST,
  listenForManagedExecutionStartup,
  resolveManagedExecutionPort
} from './endpoint-startup'

export type EndpointConfig = {
  host?: string
  port?: number
  onProtectedEffect?: (payload: ExecuteRequest['payload']) => void | Promise<void>
  bodyReadTimeoutMs?: number
  receiptStore?: ManagedExecutionReceiptStore<StoredAcceptedReceipt>
}

type ExecutionReceipt = {
  schema: 'ai-de.execution-receipt/1'
  request_id: string
  operation: string
  case_id: string
  task_id: string
  attempt_id: string
  protocol_version: string
  schema_version: string
  outcome: 'accepted' | 'replayed' | 'rejected'
  backend_kind: 'orca'
  backend_ref: string | null
  backend_session_id: string | null
  reject_reason?: IssuerErrorCode
  accepted_at: string
}

export type StoredAcceptedReceipt = {
  receipt: ExecutionReceipt & {
    outcome: 'accepted'
    backend_ref: string
    backend_session_id: string
  }
}

// Expired identities stay replayable; capacity refuses unknown identities instead of evicting.
const completedReceipts = new ManagedExecutionReceiptStore<StoredAcceptedReceipt>()
let managedExecutionTail: Promise<void> = Promise.resolve()

export async function startManagedExecutionEndpoint(
  config: EndpointConfig = {}
): Promise<Server | null> {
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return null
  }

  // A managed endpoint without its startup authority policy must not be
  // reachable. This is deliberately fail-closed rather than listening and
  // rejecting every request after the fact.
  if (!isAuthorityRegistryLoaded()) {
    console.error('[managed-execution] Authority registry is not loaded; endpoint will not start')
    return null
  }

  const host =
    config.host ?? process.env.ORCA_MANAGED_ENDPOINT_HOST ?? DEFAULT_MANAGED_EXECUTION_HOST
  const port = resolveManagedExecutionPort(config.port, process.env.ORCA_MANAGED_ENDPOINT_PORT)
  const bodyReadTimeoutMs = resolveManagedExecutionBodyReadTimeout(config.bodyReadTimeoutMs)
  const receiptStore = config.receiptStore ?? completedReceipts

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/execute') {
      respondJson(res, 404, {})
      return
    }

    let envelope: ExecuteRequest | undefined

    try {
      const body = await readManagedExecutionRequestBody(req, { timeoutMs: bodyReadTimeoutMs })
      const parsedEnvelope = parseExecuteRequest(JSON.parse(body))
      if (!parsedEnvelope) {
        respondJson(res, 400, { error: { code: IssuerErrorCode.MALFORMED_REQUEST } })
        return
      }
      const acceptedEnvelope = parsedEnvelope
      envelope = acceptedEnvelope

      await runSerializedManagedExecution(async () => {
        // Why: a launched agent may bypass approvals and sandbox; Orca must enforce
        // the receipt bound before minting authority or running the protected effect.
        if (!receiptStore.has(acceptedEnvelope.binding.request_id) && receiptStore.isAtCapacity) {
          throw new IssuerError(
            IssuerErrorCode.RECEIPT_STORE_CAPACITY_EXCEEDED,
            'Managed execution receipt store capacity reached',
            {
              layer: 'receipt-store',
              field: 'completed_receipts',
              rule: 'max-entries'
            }
          )
        }

        // 検証と capability mint
        const authorization = mintAuthorization(acceptedEnvelope)

        // 保護された効果を実行。実装は設定された managed runtime callback に委譲する。
        assertManagedExecutionAuthorized(acceptedEnvelope.binding.operation, authorization)
        await config.onProtectedEffect?.(acceptedEnvelope.payload)

        // 成功応答（execution-receipt/1 準拠、outcome=accepted）
        const receipt: StoredAcceptedReceipt['receipt'] = {
          schema: 'ai-de.execution-receipt/1',
          request_id: acceptedEnvelope.binding.request_id,
          operation: acceptedEnvelope.binding.operation,
          case_id: acceptedEnvelope.binding.case_id,
          task_id: acceptedEnvelope.binding.task_id,
          attempt_id: acceptedEnvelope.binding.attempt_id,
          protocol_version: acceptedEnvelope.binding.protocol_version,
          schema_version: acceptedEnvelope.binding.schema_version,
          outcome: 'accepted',
          backend_kind: 'orca',
          backend_ref: 'orca-backend-1',
          backend_session_id: `session-${Date.now()}`,
          accepted_at: new Date().toISOString()
        }

        if (!receiptStore.set(acceptedEnvelope.binding.request_id, { receipt })) {
          console.error(
            `[managed-execution] Receipt store admission failed: request_id=${acceptedEnvelope.binding.request_id} layer=receipt-store field=completed_receipts rule=max-entries`
          )
          respondJson(res, 500, { error: { code: 'INTERNAL_ERROR' } })
          return
        }

        respondJson(res, 200, receipt)
      })
    } catch (error) {
      if (error instanceof RequestBodyReadError) {
        console.error(
          `[managed-execution] Malformed request: request_id=取得不能 layer=${error.detail.layer} field=${error.detail.field} rule=${error.detail.rule}`
        )
        respondJson(res, 400, { error: { code: IssuerErrorCode.MALFORMED_REQUEST } })
      } else if (error instanceof IssuerError && envelope) {
        // エラー応答も receipt 形式（execution-receipt/1 準拠）
        console.error(
          `[managed-execution] Request rejected: request_id=${envelope.binding.request_id} code=${error.code} layer=${error.detail.layer} field=${error.detail.field} rule=${error.detail.rule}`
        )

        if (error.code === IssuerErrorCode.REPLAY_ATTACK) {
          const stored = receiptStore.get(envelope.binding.request_id)
          if (!stored) {
            console.error(
              `[managed-execution] Replay receipt missing: request_id=${envelope.binding.request_id}`
            )
            respondJson(res, 500, { error: { code: 'INTERNAL_ERROR' } })
            return
          }

          const replayedReceipt: ExecutionReceipt = {
            ...stored.receipt,
            outcome: 'replayed'
          }
          respondJson(res, 200, replayedReceipt)
          return
        }

        const receipt: ExecutionReceipt = {
          schema: 'ai-de.execution-receipt/1',
          request_id: envelope.binding.request_id,
          operation: envelope.binding.operation,
          case_id: envelope.binding.case_id,
          task_id: envelope.binding.task_id,
          attempt_id: envelope.binding.attempt_id,
          protocol_version: envelope.binding.protocol_version,
          schema_version: envelope.binding.schema_version,
          outcome: 'rejected',
          backend_kind: 'orca',
          backend_ref: null,
          backend_session_id: null,
          reject_reason: error.code,
          accepted_at: new Date().toISOString()
        }

        respondJson(res, 400, receipt)
      } else if (error instanceof SyntaxError) {
        console.error(
          '[managed-execution] Malformed request: request_id=取得不能 layer=envelope field=request rule=json'
        )
        respondJson(res, 400, { error: { code: IssuerErrorCode.MALFORMED_REQUEST } })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[managed-execution] Unexpected error: ${message}`)
        respondJson(res, 500, { error: { code: 'INTERNAL_ERROR' } })
      }
    }
  })
  applyManagedExecutionTimeouts(server, bodyReadTimeoutMs)

  try {
    await listenForManagedExecutionStartup(server, port, host)
  } catch (error) {
    console.error(
      `[managed-execution] Failed to listen on ${host}:${port}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    throw error
  }

  console.log(`[managed-execution] Endpoint listening on ${host}:${port}`)
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[managed-execution] Server error: ${error.message}`)
  })

  return server
}

function runSerializedManagedExecution(task: () => void | Promise<void>): Promise<void> {
  const next = managedExecutionTail.then(task, task)
  managedExecutionTail = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

type JsonRecord = Record<string, unknown>
type ShapeLayer = 'envelope' | 'binding' | 'signature' | 'payload'
type ShapeRule = 'record' | 'string' | 'constant' | 'nullable-string' | 'unexpected'

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function requestIdForShapeLog(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.binding)) {
    return '取得不能'
  }

  const requestId = value.binding.request_id
  return isString(requestId) ? requestId : '取得不能'
}

function rejectMalformedRequestShape(
  value: unknown,
  layer: ShapeLayer,
  field: string,
  rule: ShapeRule
): null {
  console.error(
    `[managed-execution] Malformed request: request_id=${requestIdForShapeLog(value)} layer=${layer} field=${field} rule=${rule}`
  )
  return null
}

function parseExecuteRequest(value: unknown): ExecuteRequest | null {
  if (!isRecord(value)) {
    return rejectMalformedRequestShape(value, 'envelope', 'request', 'record')
  }

  const envelope = value
  if (!isRecord(envelope.binding)) {
    return rejectMalformedRequestShape(value, 'envelope', 'binding', 'record')
  }
  if (!isRecord(envelope.signature)) {
    return rejectMalformedRequestShape(value, 'envelope', 'signature', 'record')
  }
  if (!isRecord(envelope.payload)) {
    return rejectMalformedRequestShape(value, 'envelope', 'payload', 'record')
  }

  const binding = envelope.binding
  const signature = envelope.signature
  const bindingStringFields = [
    'authority_id',
    'operation',
    'request_id',
    'case_id',
    'task_id',
    'attempt_id',
    'packet_digest',
    'payload_digest',
    'protocol_version',
    'schema_version'
  ] as const
  const envelopeFields = new Set([
    'schema',
    'signature',
    'binding',
    'payload',
    'issued_at',
    'expires_at'
  ])

  if (envelope.schema !== 'ai-de.execution-envelope/1') {
    return rejectMalformedRequestShape(value, 'envelope', 'schema', 'constant')
  }
  if (!isString(envelope.issued_at)) {
    return rejectMalformedRequestShape(value, 'envelope', 'issued_at', 'string')
  }
  if (!isString(envelope.expires_at)) {
    return rejectMalformedRequestShape(value, 'envelope', 'expires_at', 'string')
  }
  if (signature.algorithm !== 'ed25519') {
    return rejectMalformedRequestShape(value, 'signature', 'algorithm', 'constant')
  }
  if (signature.canonicalization !== 'RFC8785-JCS') {
    return rejectMalformedRequestShape(value, 'signature', 'canonicalization', 'constant')
  }
  if (!isString(signature.value)) {
    return rejectMalformedRequestShape(value, 'signature', 'value', 'string')
  }
  for (const field of bindingStringFields) {
    if (!isString(binding[field])) {
      return rejectMalformedRequestShape(value, 'binding', field, 'string')
    }
  }
  if (!(binding.launch_plan_digest === null || isString(binding.launch_plan_digest))) {
    return rejectMalformedRequestShape(value, 'binding', 'launch_plan_digest', 'nullable-string')
  }
  for (const field of Object.keys(envelope)) {
    if (!envelopeFields.has(field)) {
      return rejectMalformedRequestShape(value, 'envelope', field, 'unexpected')
    }
  }
  return value as unknown as ExecuteRequest
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) {
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
