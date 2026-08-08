import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startManagedExecutionEndpoint } from '../endpoint'

// モック
vi.mock('../../runtime-profile', () => ({
  getProcessRuntimeProfile: vi.fn(),
  MANAGED_ORCA_RUNTIME_PROFILE: 'managed'
}))
vi.mock('../authority-registry', () => ({
  isAuthorityRegistryLoaded: vi.fn()
}))

import { getProcessRuntimeProfile } from '../../runtime-profile'
import { isAuthorityRegistryLoaded } from '../authority-registry'

const mockGetProfile = vi.mocked(getProcessRuntimeProfile)
const mockRegistryLoaded = vi.mocked(isAuthorityRegistryLoaded)
const previousEndpointPort = process.env.ORCA_MANAGED_ENDPOINT_PORT

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegistryLoaded.mockReturnValue(true)
    delete process.env.ORCA_MANAGED_ENDPOINT_PORT
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousEndpointPort === undefined) {
      delete process.env.ORCA_MANAGED_ENDPOINT_PORT
    } else {
      process.env.ORCA_MANAGED_ENDPOINT_PORT = previousEndpointPort
    }
  })

  test('default profile で endpoint が開かない', async () => {
    mockGetProfile.mockReturnValue('default')
    const server = await startManagedExecutionEndpoint()
    expect(server).toBeNull()
  })

  test('managed profile で endpoint が開く', async () => {
    mockGetProfile.mockReturnValue('managed')
    const server = await startManagedExecutionEndpoint({ port: 0 }) // ポート0で自動割り当て
    expect(server).not.toBeNull()
    expect(server?.listening).toBe(true)
    await closeServer(server!)
  })

  test('managed profile で authority registry が未ロードなら endpoint が開かない', async () => {
    mockGetProfile.mockReturnValue('managed')
    mockRegistryLoaded.mockReturnValue(false)
    const server = await startManagedExecutionEndpoint()
    expect(server).toBeNull()
  })

  test('loopback (127.0.0.1) に bind される', async () => {
    mockGetProfile.mockReturnValue('managed')
    const server = await startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    const address = server?.address()
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')
    expect((address as AddressInfo).address).toBe('127.0.0.1')

    await closeServer(server!)
  })

  test('ポート使用中は起動を拒否する（EADDRINUSE）', async () => {
    mockGetProfile.mockReturnValue('managed')

    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const occupiedPort = (blocker.address() as AddressInfo).port

    try {
      await expect(startManagedExecutionEndpoint({ port: occupiedPort })).rejects.toMatchObject({
        code: 'EADDRINUSE'
      })
    } finally {
      await closeServer(blocker)
    }
  })

  test.each([-1, 65_536, 1.5, Number.POSITIVE_INFINITY])(
    '不正なポート %s は起動前に拒否する',
    async (port) => {
      mockGetProfile.mockReturnValue('managed')
      await expect(startManagedExecutionEndpoint({ port })).rejects.toThrow(
        'endpoint configuration must be an integer between 0 and 65535'
      )
    }
  )

  test('環境変数の不正なポートは起動前に拒否する', async () => {
    mockGetProfile.mockReturnValue('managed')
    process.env.ORCA_MANAGED_ENDPOINT_PORT = 'not-a-port'

    await expect(startManagedExecutionEndpoint()).rejects.toThrow(
      'ORCA_MANAGED_ENDPOINT_PORT must be an integer between 0 and 65535'
    )
  })
})
