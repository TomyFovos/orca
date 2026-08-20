import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { getProcessRuntimeProfile, MANAGED_ORCA_RUNTIME_PROFILE } from '../runtime-profile'
import { isAuthorityRegistryLoaded } from './authority-registry'
import { mintAuthorization, IssuerError, IssuerErrorCode, type ExecuteRequest } from './issuer'
import { assertManagedExecutionAuthorized } from './authorization'

const DEFAULT_PORT = 6770
const DEFAULT_HOST = '127.0.0.1'

export type EndpointConfig = {
  host?: string
  port?: number
  onProtectedEffect?: (payload: ExecuteRequest['payload']) => void
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

type StoredAcceptedReceipt = {
  receipt: ExecutionReceipt & {
    outcome: 'accepted'
    backend_ref: string
    backend_session_id: string
  }
}

const completedReceipts = new Map<string, StoredAcceptedReceipt>() // Retain expired-known receipts.

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

  const host = config.host ?? process.env.ORCA_MANAGED_ENDPOINT_HOST ?? DEFAULT_HOST
  const port = resolvePort(config.port, process.env.ORCA_MANAGED_ENDPOINT_PORT)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/execute') {
      res.writeHead(404)
      res.end()
      return
    }

    let envelope: ExecuteRequest | undefined

    try {
      const body = await readBody(req)
      const parsedEnvelope = parseExecuteRequest(JSON.parse(body))
      if (!parsedEnvelope) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: IssuerErrorCode.MALFORMED_REQUEST } }))
        return
      }
      envelope = parsedEnvelope

      // 検証と capability mint
      const authorization = mintAuthorization(envelope)

      // 保護された効果を実行。実装は設定された managed runtime callback に委譲する。
      assertManagedExecutionAuthorized(envelope.binding.operation, authorization)
      config.onProtectedEffect?.(envelope.payload)

      // 成功応答（execution-receipt/1 準拠、outcome=accepted）
      const receipt: StoredAcceptedReceipt['receipt'] = {
        schema: 'ai-de.execution-receipt/1',
        request_id: envelope.binding.request_id,
        operation: envelope.binding.operation,
        case_id: envelope.binding.case_id,
        task_id: envelope.binding.task_id,
        attempt_id: envelope.binding.attempt_id,
        protocol_version: envelope.binding.protocol_version,
        schema_version: envelope.binding.schema_version,
        outcome: 'accepted',
        backend_kind: 'orca',
        backend_ref: 'orca-backend-1',
        backend_session_id: `session-${Date.now()}`,
        accepted_at: new Date().toISOString()
      }

      completedReceipts.set(envelope.binding.request_id, {
        receipt
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(receipt))
    } catch (error) {
      if (error instanceof IssuerError && envelope) {
        // エラー応答も receipt 形式（execution-receipt/1 準拠）
        console.error(
          `[managed-execution] Request rejected: request_id=${envelope.binding.request_id} code=${error.code} layer=${error.detail.layer} field=${error.detail.field} rule=${error.detail.rule}`
        )

        if (error.code === IssuerErrorCode.REPLAY_ATTACK) {
          const stored = completedReceipts.get(envelope.binding.request_id)
          if (!stored) {
            console.error(
              `[managed-execution] Replay receipt missing: request_id=${envelope.binding.request_id}`
            )
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }))
            return
          }

          const replayedReceipt: ExecutionReceipt = {
            ...stored.receipt,
            outcome: 'replayed'
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(replayedReceipt))
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

        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(receipt))
      } else if (error instanceof SyntaxError) {
        console.error(
          '[managed-execution] Malformed request: request_id=取得不能 layer=envelope field=request rule=json'
        )
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: IssuerErrorCode.MALFORMED_REQUEST } }))
      } else {
        console.error(`[managed-execution] Unexpected error: ${error}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }))
      }
    }
  })

  try {
    await listenForStartup(server, port, host)
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

function resolvePort(configPort: number | undefined, environmentPort: string | undefined): number {
  if (configPort !== undefined) {
    return validatePort(configPort, 'endpoint configuration')
  }
  if (environmentPort === undefined) {
    return DEFAULT_PORT
  }
  return validatePort(Number(environmentPort), 'ORCA_MANAGED_ENDPOINT_PORT')
}

function validatePort(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${source} must be an integer between 0 and 65535`)
  }
  return value
}

function listenForStartup(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }

    server.once('listening', onListening)
    server.once('error', onError)
    try {
      server.listen(port, host)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
