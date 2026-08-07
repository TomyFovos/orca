import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { startManagedExecutionEndpoint } from '../endpoint'
import { createServer } from 'node:http'

// モック
vi.mock('../../runtime-profile', () => ({
  getProcessRuntimeProfile: vi.fn(),
  MANAGED_ORCA_RUNTIME_PROFILE: 'managed'
}))

import { getProcessRuntimeProfile } from '../../runtime-profile'

const mockGetProfile = vi.mocked(getProcessRuntimeProfile)

describe('endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('default profile で endpoint が開かない', () => {
    mockGetProfile.mockReturnValue('default')
    const server = startManagedExecutionEndpoint()
    expect(server).toBeNull()
  })

  test('managed profile で endpoint が開く', async () => {
    mockGetProfile.mockReturnValue('managed')
    const server = startManagedExecutionEndpoint({ port: 0 }) // ポート0で自動割り当て
    expect(server).not.toBeNull()

    // サーバーが listen 完了するまで待機
    await new Promise<void>((resolve) => {
      server!.once('listening', () => resolve())
    })

    server?.close()
  })

  test('loopback (127.0.0.1) に bind される', async () => {
    mockGetProfile.mockReturnValue('managed')
    const server = startManagedExecutionEndpoint({ port: 0 })
    expect(server).not.toBeNull()

    // サーバーが listen 完了するまで待機
    await new Promise<void>((resolve) => {
      server!.once('listening', () => resolve())
    })

    // サーバーのアドレスを確認
    const address = server?.address()
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')
    if (address && typeof address === 'object') {
      expect(address.address).toBe('127.0.0.1')
    }

    server?.close()
  })

  test('ポート使用中は起動を中止する（EADDRINUSE）', async () => {
    mockGetProfile.mockReturnValue('managed')

    // 先にポートを占有
    const occupiedPort = 16769 // テスト用のポート
    const blocker = createServer()
    await new Promise<void>((resolve) => {
      blocker.listen(occupiedPort, '127.0.0.1', () => resolve())
    })

    // process.exit が呼ばれることを確認
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    try {
      startManagedExecutionEndpoint({ port: occupiedPort })

      // error イベントが発生して process.exit が呼ばれるまで待機
      await new Promise<void>((resolve) => {
        const checkExit = setInterval(() => {
          if (exitSpy.mock.calls.length > 0) {
            clearInterval(checkExit)
            resolve()
          }
        }, 10)

        // タイムアウト（2秒）
        setTimeout(() => {
          clearInterval(checkExit)
          resolve()
        }, 2000)
      })

      // process.exit(1) が呼ばれたことを確認
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
      blocker.close()
    }
  })
})
