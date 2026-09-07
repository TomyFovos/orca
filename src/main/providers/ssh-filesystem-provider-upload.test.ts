import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

function createMockMux() {
  return {
    request: vi.fn(),
    onNotification: vi.fn(() => () => {})
  }
}

describe('SshFilesystemProvider binary uploads', () => {
  let mux: ReturnType<typeof createMockMux>
  let provider: SshFilesystemProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshFilesystemProvider('conn-1', mux as never)
  })

  describe('writeFileBase64', () => {
    it('writes decoded bytes through SFTP', async () => {
      const written: Buffer[] = []
      const writeStream = {
        on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        off: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        end: vi.fn((buffer: Buffer) => {
          written.push(buffer)
          const closeHandler = writeStream.on.mock.calls.find(([event]) => event === 'close')?.[1]
          closeHandler?.()
        }),
        destroy: vi.fn()
      }
      const sftp = {
        createWriteStream: vi.fn(() => writeStream),
        end: vi.fn()
      }
      provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

      await provider.writeFileBase64('/home/user/logo.png', 'cG5n')

      expect(sftp.createWriteStream).toHaveBeenCalledWith('/home/user/logo.png', { flags: 'wx' })
      expect(written).toEqual([Buffer.from('png')])
      expect(sftp.end).toHaveBeenCalled()
      expect(mux.request).not.toHaveBeenCalledWith('fs.writeFile', expect.anything())
    })

    it('writes decoded bytes through raw transfer when provided', async () => {
      const writeBuffer = vi.fn().mockResolvedValue(undefined)
      provider = new SshFilesystemProvider('conn-1', mux as never, undefined, { writeBuffer })

      await provider.writeFileBase64('/home/user/logo.png', 'cG5n')
      await provider.writeFileBase64Chunk('/home/user/logo.png', 'bW9yZQ==', true)

      expect(writeBuffer).toHaveBeenNthCalledWith(1, '/home/user/logo.png', Buffer.from('png'), {
        append: false,
        exclusive: true
      })
      expect(writeBuffer).toHaveBeenNthCalledWith(2, '/home/user/logo.png', Buffer.from('more'), {
        append: true,
        exclusive: false
      })
    })

    it('can append decoded chunks through SFTP', async () => {
      const writeStream = {
        on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        off: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        end: vi.fn((_buffer: Buffer) => {
          const closeHandler = writeStream.on.mock.calls.find(([event]) => event === 'close')?.[1]
          closeHandler?.()
        }),
        destroy: vi.fn()
      }
      const sftp = {
        createWriteStream: vi.fn(() => writeStream),
        end: vi.fn()
      }
      provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

      await provider.writeFileBase64Chunk('/home/user/logo.png', 'cG5n', true)

      expect(sftp.createWriteStream).toHaveBeenCalledWith('/home/user/logo.png', { flags: 'a' })
      expect(sftp.end).toHaveBeenCalled()
    })
  })
})
