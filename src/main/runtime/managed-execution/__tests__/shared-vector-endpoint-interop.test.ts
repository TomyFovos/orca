import { createPublicKey } from 'node:crypto'
import * as fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'

const vectorsPath = path.join(
  __dirname,
  'fixtures',
  'execution-envelope-signature-test-vectors.json'
)
const vector = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8')).vectors[0]

const VECTOR_AUTHORITY_ID: string = vector.envelope.binding.authority_id
const VECTOR_PUBLIC_KEY_PEM = createPublicKey({
  key: Buffer.from(vector.signing_key.public_key_spki_base64, 'base64'),
  format: 'der',
  type: 'spki'
})
  .export({ format: 'pem', type: 'spki' })
  .toString()

// Why: the vector's authority_id carries the `test-` prefix that must never reach a
// production registry. A module mock exists only inside the vitest module graph — the
// packaged main process imports the real authority-registry, and no code path can load
// this replacement. That is a structural exclusion, not a convention.
vi.mock('../authority-registry', () => ({
  isAuthorityRegistryLoaded: () => true,
  lookupAuthority: (authorityId: string) =>
    authorityId === VECTOR_AUTHORITY_ID
      ? { publicKey: VECTOR_PUBLIC_KEY_PEM, revoked: false }
      : undefined,
  isAuthorityRevoked: () => false
}))

const { startManagedExecutionEndpoint } = await import('../endpoint')

// The vector is normative and must not be edited to suit the clock: pin the clock instead.
const VECTOR_ISSUED_AT = Date.parse(vector.envelope.issued_at)
const WITHIN_VECTOR_VALIDITY = VECTOR_ISSUED_AT + 60_000

async function postEnvelope(
  port: number,
  body: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  return { status: response.status, body: await response.json() }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('AI-DE 共有署名ベクタの endpoint 経路', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(WITHIN_VECTOR_VALIDITY)
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
  })

  afterEach(() => {
    vi.useRealTimers()
    setProcessRuntimeProfile('default')
  })

  it('ベクタの envelope を無改変で受理し、shape 検査も署名検証も通す', async () => {
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    try {
      const port = (server!.address() as AddressInfo).port
      const response = await postEnvelope(port, JSON.stringify(vector.envelope))

      expect(response.body).not.toMatchObject({ error: { code: 'MALFORMED_REQUEST' } })
      expect(response.body).not.toMatchObject({ reject_reason: 'INVALID_SIGNATURE' })
      expect(response.body).not.toMatchObject({ reject_reason: 'PAYLOAD_DIGEST_MISMATCH' })
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        schema: 'ai-de.execution-receipt/1',
        outcome: 'accepted',
        request_id: vector.envelope.binding.request_id,
        operation: vector.envelope.binding.operation,
        case_id: vector.envelope.binding.case_id,
        task_id: vector.envelope.binding.task_id,
        attempt_id: vector.envelope.binding.attempt_id,
        protocol_version: vector.envelope.binding.protocol_version,
        schema_version: vector.envelope.binding.schema_version
      })
    } finally {
      await closeServer(server!)
    }
  })

  it('wire は envelope 単体である — 入れ子ラッパは MALFORMED_REQUEST になる', async () => {
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    try {
      const port = (server!.address() as AddressInfo).port
      const nested = await postEnvelope(
        port,
        JSON.stringify({
          envelope: vector.envelope,
          operation_payload: vector.envelope.payload
        })
      )

      expect(nested.status).toBe(400)
      expect(nested.body).toEqual({ error: { code: 'MALFORMED_REQUEST' } })
    } finally {
      await closeServer(server!)
    }
  })

  it('payload は envelope.payload に入れ子で、差し替えると payload_digest が一致しない', async () => {
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = (server!.address() as AddressInfo).port
      const substituted = {
        ...vector.envelope,
        payload: { ...vector.envelope.payload, case_id: 'substituted-by-test' }
      }
      const response = await postEnvelope(port, JSON.stringify(substituted))

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        outcome: 'rejected',
        reject_reason: 'PAYLOAD_DIGEST_MISMATCH'
      })
      expect(errorSpy).toHaveBeenCalledWith(
        `[managed-execution] Request rejected: request_id=${vector.envelope.binding.request_id} code=PAYLOAD_DIGEST_MISMATCH layer=binding field=payload_digest rule=matches-envelope-payload`
      )
    } finally {
      errorSpy.mockRestore()
      await closeServer(server!)
    }
  })
})
