import { afterEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { getAuthorityRegistry } from '../authority-registry'
import { canonicalBytes } from '../canonical'
import { startManagedExecutionEndpoint } from '../endpoint'
import type { ExecuteRequest } from '../issuer'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'

const keyPair = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

function sha256Json(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function createSignedRequest(): ExecuteRequest {
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 60_000)
  const operationPayload = {
    case_id: 'managed-e2e-case',
    task_id: 'managed-e2e-task',
    attempt_id: 'managed-e2e-attempt',
    packet_digest: `sha256:${'0'.repeat(64)}`
  }
  const binding = {
    authority_id: 'managed-e2e-authority',
    request_id: randomUUID(),
    case_id: operationPayload.case_id,
    task_id: operationPayload.task_id,
    attempt_id: operationPayload.attempt_id,
    packet_digest: operationPayload.packet_digest,
    launch_plan_digest: null,
    operation: 'start',
    payload_digest: sha256Json(operationPayload),
    protocol_version: 'ai-de-trusted-launcher/1',
    schema_version: 'execution-envelope-1',
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString()
  }
  const signature = sign(null, canonicalBytes(binding), keyPair.privateKey)

  return {
    envelope: {
      schema: 'ai-de.execution-envelope/1',
      signature: {
        algorithm: 'ed25519',
        canonicalization: 'RFC8785-JCS',
        value: signature.toString('hex')
      },
      binding,
      payload: operationPayload,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString()
    },
    operation_payload: operationPayload
  }
}

async function closeServer(server: NonNullable<ReturnType<typeof startManagedExecutionEndpoint>>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('managed execution endpoint authorization path', () => {
  afterEach(() => {
    setProcessRuntimeProfile('default')
    getAuthorityRegistry().clear()
  })

  it('executes a correctly signed envelope through the protected endpoint', async () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    getAuthorityRegistry().set('managed-e2e-authority', {
      publicKey: keyPair.publicKey,
      revoked: false
    })

    const server = startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve)
      server!.once('error', reject)
    })

    try {
      const address = server!.address()
      expect(address).not.toBeNull()
      expect(typeof address).toBe('object')
      const port = (address as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createSignedRequest())
      })
      const receipt = await response.json()

      expect(response.status).toBe(200)
      expect(receipt).toMatchObject({
        schema: 'ai-de.execution-receipt/1',
        outcome: 'accepted',
        backend_kind: 'orca'
      })
      expect(receipt.error).toBeUndefined()
    } finally {
      await closeServer(server!)
    }
  })
})
