import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'
import { MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS } from './request-body-reader'

const MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MULTIPLIER = 4

// Bypassed agents can hold a socket open; keep effect waits finite but separate from body ingress.
export const MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MS =
  MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS * MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MULTIPLIER

export function resolveManagedExecutionBodyReadTimeout(value: number | undefined): number {
  if (value === undefined) {
    return MANAGED_EXECUTION_BODY_READ_TIMEOUT_MS
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('bodyReadTimeoutMs must be a positive integer')
  }
  return value
}

export function applyManagedExecutionTimeouts(server: Server, bodyReadTimeoutMs: number): void {
  const responseSocketIdleTimeoutMs =
    resolveManagedExecutionResponseSocketIdleTimeout(bodyReadTimeoutMs)

  // These timers bound header/body ingress; the socket timer bounds effect-to-response idleness.
  server.headersTimeout = bodyReadTimeoutMs
  server.requestTimeout = bodyReadTimeoutMs
  server.setTimeout(responseSocketIdleTimeoutMs, onSocketIdleTimeout)
}

export function resolveManagedExecutionResponseSocketIdleTimeout(
  bodyReadTimeoutMs: number
): number {
  const responseSocketIdleTimeoutMs =
    bodyReadTimeoutMs * MANAGED_EXECUTION_RESPONSE_SOCKET_IDLE_TIMEOUT_MULTIPLIER
  if (
    !Number.isSafeInteger(responseSocketIdleTimeoutMs) ||
    responseSocketIdleTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error('bodyReadTimeoutMs is too large for managed execution socket timeout')
  }
  return responseSocketIdleTimeoutMs
}

function onSocketIdleTimeout(socket: Socket): void {
  console.error(
    '[managed-execution] Socket timeout: request_id=null unresolved_fields=request_id layer=transport field=connection rule=socket-idle-timeout'
  )
  socket.destroy()
}
