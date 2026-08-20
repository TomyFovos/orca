import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import {
  applyManagedExecutionTimeouts,
  MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MS,
  resolveManagedExecutionResponseSocketIdleTimeout
} from '../endpoint-timeouts'
import { MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS } from '../request-body-reader'

function timeoutListener(server: Server): (socket: Socket) => void {
  const listeners = server.listeners('timeout')
  expect(listeners).toHaveLength(1)
  return listeners[0] as (socket: Socket) => void
}

describe('managed execution timeout clocks', () => {
  it('keeps ingress timers on the body budget and response sockets on the longer idle budget', () => {
    const server = createServer()

    applyManagedExecutionTimeouts(server, MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS)

    expect(server.headersTimeout).toBe(MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS)
    expect(server.requestTimeout).toBe(MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS)
    expect(server.timeout).toBe(MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MS)
    expect(server.timeout).toBeGreaterThan(server.requestTimeout)
  })

  it('scales the response budget with a configured body budget', () => {
    const server = createServer()
    const bodyReadTimeoutMs = 30

    applyManagedExecutionTimeouts(server, bodyReadTimeoutMs)

    expect(server.headersTimeout).toBe(bodyReadTimeoutMs)
    expect(server.requestTimeout).toBe(bodyReadTimeoutMs)
    expect(server.timeout).toBe(resolveManagedExecutionResponseSocketIdleTimeout(bodyReadTimeoutMs))
    expect(server.timeout).toBeGreaterThan(bodyReadTimeoutMs)
  })

  it('fires the response socket rejection path with a structured transport reason', () => {
    const server = createServer()
    const socket = { destroy: vi.fn() } as unknown as Socket
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      applyManagedExecutionTimeouts(server, 30)
      timeoutListener(server)(socket)

      expect(socket.destroy).toHaveBeenCalledOnce()
      expect(errorSpy).toHaveBeenCalledWith(
        '[managed-execution] Socket timeout: request_id=取得不能 layer=transport field=connection rule=socket-idle-timeout'
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
