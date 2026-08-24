import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

vi.mock('../../runtime-profile', () => ({
  getProcessRuntimeProfile: () => 'managed',
  MANAGED_ORCA_RUNTIME_PROFILE: 'managed'
}))
vi.mock('../authority-registry', () => ({ isAuthorityRegistryLoaded: () => true }))
vi.mock('../authorization', () => ({ assertExternalManagedExecutionAuthorized: () => {} }))
vi.mock('../issuer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, mintAuthorization: () => ({}) }
})

import { startManagedExecutionEndpoint } from '../endpoint'
import { AttemptIdentityRegistry } from '../attempt-identity-registry'
import type { ExecuteRequest } from '../issuer'

function request(operation: string, attemptId: string): ExecuteRequest {
  const requestId = randomUUID()
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  return {
    schema: 'ai-de.execution-envelope/1',
    signature: {
      algorithm: 'ed25519',
      canonicalization: 'RFC8785-JCS',
      value: '0'.repeat(128)
    },
    binding: {
      authority_id: 'attempt-identity-test',
      operation,
      request_id: requestId,
      case_id: 'case-1',
      task_id: 'task-1',
      attempt_id: attemptId,
      packet_digest: `sha256:${'0'.repeat(64)}`,
      launch_plan_digest: null,
      payload_digest: `sha256:${'1'.repeat(64)}`,
      protocol_version: '1',
      schema_version: '1'
    },
    payload: { operation, request_id: requestId, attempt_id: attemptId },
    issued_at: issuedAt,
    expires_at: expiresAt
  }
}

async function post(port: number, body: ExecuteRequest) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, receipt: await response.json() }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function assertAiDeAttemptBinding(
  prior: { backend_ref: string; backend_session_id: string },
  receipt: { backend_ref: string; backend_session_id: string }
): void {
  for (const field of ['backend_ref', 'backend_session_id'] as const) {
    if (prior[field] !== receipt[field]) {
      throw new Error(`SCHEMA_MISMATCH field=/${field} rule=attempt-session-binding`)
    }
  }
}

describe('managed execution attempt identity', () => {
  afterEach(() => vi.restoreAllMocks())

  it('mints once per attempt and reuses the identity for later verbs', async () => {
    const identities = new AttemptIdentityRegistry()
    const server = await startManagedExecutionEndpoint({ port: 0, attemptIdentities: identities })
    try {
      const port = (server!.address() as AddressInfo).port
      const attemptId = `attempt-${randomUUID()}`
      const prepared = await post(port, request('prepare', attemptId))
      const stopped = await post(port, request('stop', attemptId))
      const first = prepared.receipt as { backend_ref: string; backend_session_id: string }
      const later = stopped.receipt as { backend_ref: string; backend_session_id: string }

      expect(prepared.status).toBe(200)
      expect(stopped.status).toBe(200)
      expect(first.backend_ref).toMatch(/^orca-attempt-/)
      expect(first.backend_session_id).toMatch(/^orca-session-/)
      expect(later.backend_ref).toBe(first.backend_ref)
      expect(later.backend_session_id).toBe(first.backend_session_id)
      expect(() => assertAiDeAttemptBinding(first, later)).not.toThrow()
      expect(identities.size).toBe(1)
    } finally {
      await closeServer(server!)
    }
  })

  it('assigns distinguishable identities to different attempts', async () => {
    const server = await startManagedExecutionEndpoint({
      port: 0,
      attemptIdentities: new AttemptIdentityRegistry()
    })
    try {
      const port = (server!.address() as AddressInfo).port
      const first = await post(port, request('prepare', `attempt-${randomUUID()}`))
      const second = await post(port, request('prepare', `attempt-${randomUUID()}`))
      const receiptA = first.receipt as { backend_ref: string; backend_session_id: string }
      const receiptB = second.receipt as { backend_ref: string; backend_session_id: string }

      expect(receiptA.backend_ref).not.toBe(receiptB.backend_ref)
      expect(receiptA.backend_session_id).not.toBe(receiptB.backend_session_id)
      expect(() => assertAiDeAttemptBinding(receiptA, receiptB)).toThrow(
        /rule=attempt-session-binding/
      )

      // Negative control: same-millisecond pre-fix receipts shared both compared values.
      const legacy = { backend_ref: 'orca-backend-1', backend_session_id: 'session-1700000000000' }
      expect(() => assertAiDeAttemptBinding(legacy, { ...legacy })).not.toThrow()
    } finally {
      await closeServer(server!)
    }
  })

  it('rejects an unknown attempt before its protected effect', async () => {
    const effect = vi.fn()
    const server = await startManagedExecutionEndpoint({
      port: 0,
      attemptIdentities: new AttemptIdentityRegistry(),
      onProtectedEffect: effect
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = (server!.address() as AddressInfo).port
      const rejected = await post(port, request('stop', `unknown-${randomUUID()}`))

      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'UNKNOWN_ATTEMPT'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'code=UNKNOWN_ATTEMPT layer=attempt-registry field=attempt_id rule=registered-attempt'
        )
      )
      expect(effect).not.toHaveBeenCalled()
    } finally {
      await closeServer(server!)
    }
  })

  it('rejects new attempts at capacity without evicting an existing binding', async () => {
    const identities = new AttemptIdentityRegistry(1)
    const server = await startManagedExecutionEndpoint({ port: 0, attemptIdentities: identities })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = (server!.address() as AddressInfo).port
      const firstAttempt = `attempt-${randomUUID()}`
      const accepted = await post(port, request('prepare', firstAttempt))
      const firstIdentity = identities.get(firstAttempt)
      const rejected = await post(port, request('prepare', `attempt-${randomUUID()}`))

      expect(accepted.status).toBe(200)
      expect(rejected.status).toBe(400)
      expect(rejected.receipt).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'ATTEMPT_REGISTRY_CAPACITY_EXCEEDED'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'code=ATTEMPT_REGISTRY_CAPACITY_EXCEEDED layer=attempt-registry field=accepted_attempts rule=max-entries'
        )
      )
      expect(identities.get(firstAttempt)).toEqual(firstIdentity)
      expect(identities.size).toBe(1)
    } finally {
      await closeServer(server!)
    }
  })

  it('does not register a prepare whose protected effect fails', async () => {
    const identities = new AttemptIdentityRegistry()
    const attemptId = `attempt-${randomUUID()}`
    const server = await startManagedExecutionEndpoint({
      port: 0,
      attemptIdentities: identities,
      onProtectedEffect: () => {
        throw new Error('effect refused by test')
      }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = (server!.address() as AddressInfo).port
      const rejected = await post(port, request('prepare', attemptId))

      expect(rejected.status).toBe(500)
      expect(identities.has(attemptId)).toBe(false)
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })
})
