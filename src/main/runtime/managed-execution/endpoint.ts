import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { getProcessRuntimeProfile, MANAGED_ORCA_RUNTIME_PROFILE } from '../runtime-profile'
import { mintAuthorization, IssuerError, IssuerErrorCode, type ExecuteRequest } from './issuer'
import { assertManagedExecutionAuthorized } from './authorization'

const DEFAULT_PORT = 6769
const DEFAULT_HOST = '127.0.0.1'

export type EndpointConfig = {
  host?: string
  port?: number
  onProtectedEffect?: (request: ExecuteRequest) => void
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
  expires_at: string
  receipt: ExecutionReceipt & {
    outcome: 'accepted'
    backend_ref: string
    backend_session_id: string
  }
}

const completedReceipts = new Map<string, StoredAcceptedReceipt>()

export function startManagedExecutionEndpoint(config: EndpointConfig = {}): Server | null {
  // managed profile でのみ listen
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return null
  }

  const host = config.host ?? process.env.ORCA_MANAGED_ENDPOINT_HOST ?? DEFAULT_HOST
  const port = config.port ?? (Number(process.env.ORCA_MANAGED_ENDPOINT_PORT) || DEFAULT_PORT)
  const onProtectedEffect = config.onProtectedEffect

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/execute') {
      res.writeHead(404)
      res.end()
      return
    }

    let request: ExecuteRequest | undefined

    try {
      cleanupExpiredReceipts()
      const body = await readBody(req)
      const parsedRequest = parseExecuteRequest(JSON.parse(body))
      if (!parsedRequest) {
        console.error('[managed-execution] Malformed request: invalid request shape')
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: IssuerErrorCode.MALFORMED_REQUEST } }))
        return
      }
      request = parsedRequest

      // 検証と capability mint
      const authorization = mintAuthorization(request)

      // 保護された効果を実行（この例では何もしない）
      // 実際には operation に応じた処理を行う
      assertManagedExecutionAuthorized(request.envelope.binding.operation, authorization)
      onProtectedEffect?.(request)

      // 成功応答（execution-receipt/1 準拠、outcome=accepted）
      const receipt: StoredAcceptedReceipt['receipt'] = {
        schema: 'ai-de.execution-receipt/1',
        request_id: request.envelope.binding.request_id,
        operation: request.envelope.binding.operation,
        case_id: request.envelope.binding.case_id,
        task_id: request.envelope.binding.task_id,
        attempt_id: request.envelope.binding.attempt_id,
        protocol_version: request.envelope.binding.protocol_version,
        schema_version: request.envelope.binding.schema_version,
        outcome: 'accepted',
        backend_kind: 'orca',
        backend_ref: 'orca-backend-1',
        backend_session_id: `session-${Date.now()}`,
        accepted_at: new Date().toISOString()
      }

      completedReceipts.set(request.envelope.binding.request_id, {
        expires_at: request.envelope.expires_at,
        receipt
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(receipt))
    } catch (error) {
      if (error instanceof IssuerError && request) {
        // エラー応答も receipt 形式（execution-receipt/1 準拠）
        console.error(`[managed-execution] Request rejected: code=${error.code}`)

        if (error.code === IssuerErrorCode.REPLAY_ATTACK) {
          const stored = completedReceipts.get(request.envelope.binding.request_id)
          if (!stored) {
            console.error(
              `[managed-execution] Replay receipt missing: request_id=${request.envelope.binding.request_id}`
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
          request_id: request.envelope.binding.request_id,
          operation: request.envelope.binding.operation,
          case_id: request.envelope.binding.case_id,
          task_id: request.envelope.binding.task_id,
          attempt_id: request.envelope.binding.attempt_id,
          protocol_version: request.envelope.binding.protocol_version,
          schema_version: request.envelope.binding.schema_version,
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
        console.error(`[managed-execution] Malformed request: ${error.message}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: IssuerErrorCode.MALFORMED_REQUEST } }))
      } else {
        console.error(`[managed-execution] Unexpected error: ${error}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }))
      }
    }
  })

  server.listen(port, host, () => {
    console.log(`[managed-execution] Endpoint listening on ${host}:${port}`)
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[managed-execution] Port ${port} is already in use. Set ORCA_MANAGED_ENDPOINT_PORT to use a different port.`
      )
      process.exit(1)
    } else {
      console.error(`[managed-execution] Server error: ${error.message}`)
    }
  })

  return server
}

function cleanupExpiredReceipts() {
  const now = Date.now()
  for (const [requestId, stored] of completedReceipts.entries()) {
    if (new Date(stored.expires_at).getTime() < now) {
      completedReceipts.delete(requestId)
    }
  }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function parseExecuteRequest(value: unknown): ExecuteRequest | null {
  if (!isRecord(value) || !isRecord(value.envelope) || !isRecord(value.operation_payload)) {
    return null
  }

  const envelope = value.envelope
  const operationPayload = value.operation_payload
  if (!isRecord(envelope.binding) || !isRecord(envelope.signature) || !isRecord(envelope.payload)) {
    return null
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
  const operationPayloadStringFields = [
    'case_id',
    'task_id',
    'attempt_id',
    'packet_digest'
  ] as const

  if (
    envelope.schema !== 'ai-de.execution-envelope/1' ||
    !isString(envelope.issued_at) ||
    !isString(envelope.expires_at) ||
    signature.algorithm !== 'ed25519' ||
    signature.canonicalization !== 'RFC8785-JCS' ||
    !isString(signature.value) ||
    !bindingStringFields.every((field) => isString(binding[field])) ||
    !(binding.launch_plan_digest === null || isString(binding.launch_plan_digest)) ||
    !operationPayloadStringFields.every((field) => isString(operationPayload[field]))
  ) {
    return null
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
