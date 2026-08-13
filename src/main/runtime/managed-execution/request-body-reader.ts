import type { IncomingMessage } from 'node:http'

// 8 MiB admits the contract's 3,145,730-byte escaped-prompt envelope while bounding input.
export const MAX_MANAGED_EXECUTION_BODY_BYTES = 8 * 1024 * 1024
export const MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS = 15_000

export type RequestBodyRejectionDetail = Readonly<{
  layer: 'transport'
  field: 'body' | 'connection'
  rule: 'maximum-bytes' | 'read-timeout' | 'client-aborted' | 'connection-closed' | 'stream-error'
}>

export class RequestBodyReadError extends Error {
  constructor(public readonly detail: RequestBodyRejectionDetail) {
    super(`Request body rejected: ${detail.rule}`)
    this.name = 'RequestBodyReadError'
  }
}

type RequestBodyReadOptions = Readonly<{
  maximumBytes?: number
  timeoutMs?: number
}>

export function readManagedExecutionRequestBody(
  req: IncomingMessage,
  options: RequestBodyReadOptions = {}
): Promise<string> {
  const maximumBytes = options.maximumBytes ?? MAX_MANAGED_EXECUTION_BODY_BYTES
  const timeoutMs = options.timeoutMs ?? MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bodyBytes = 0
    let settled = false
    const timeout = setTimeout(() => {
      rejectBody({ layer: 'transport', field: 'body', rule: 'read-timeout' })
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      req.off('close', onClose)
    }
    const settle = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    const rejectBody = (detail: RequestBodyRejectionDetail) => {
      settle(() => reject(new RequestBodyReadError(detail)))
    }
    const onData = (chunk: Buffer) => {
      bodyBytes += chunk.length
      if (bodyBytes > maximumBytes) {
        rejectBody({ layer: 'transport', field: 'body', rule: 'maximum-bytes' })
        req.resume()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      settle(() => resolve(Buffer.concat(chunks).toString('utf8')))
    }
    const onError = () => {
      rejectBody({ layer: 'transport', field: 'connection', rule: 'stream-error' })
    }
    const onAborted = () => {
      rejectBody({ layer: 'transport', field: 'connection', rule: 'client-aborted' })
    }
    const onClose = () => {
      if (!req.complete) {
        rejectBody({ layer: 'transport', field: 'connection', rule: 'connection-closed' })
      }
    }

    // An agent can bypass its own sandbox, so Orca bounds this pre-authorization input.
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}
