import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestBodyReadError, readManagedExecutionRequestBody } from '../request-body-reader'

type TestRequest = Omit<IncomingMessage, 'resume'> & { resume: ReturnType<typeof vi.fn> }

function createRequest(): TestRequest {
  const request = new EventEmitter() as unknown as TestRequest
  request.complete = false
  request.resume = vi.fn()
  return request
}

describe('managed execution request body reader', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the body read timeout as a transport rejection', async () => {
    vi.useFakeTimers()
    const request = createRequest()
    const pending = readManagedExecutionRequestBody(request as unknown as IncomingMessage, {
      timeoutMs: 30
    })

    vi.advanceTimersByTime(30)

    await expect(pending).rejects.toBeInstanceOf(RequestBodyReadError)
    await expect(pending).rejects.toMatchObject({
      detail: { layer: 'transport', field: 'body', rule: 'read-timeout' }
    })
  })

  it('preserves client-abort classification independently of timeout', async () => {
    const request = createRequest()
    const pending = readManagedExecutionRequestBody(request as unknown as IncomingMessage, {
      timeoutMs: 30_000
    })
    request.emit('aborted')

    await expect(pending).rejects.toMatchObject({
      detail: { layer: 'transport', field: 'connection', rule: 'client-aborted' }
    })
  })
})
