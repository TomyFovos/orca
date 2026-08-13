import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { subscribeWithInProcessWatcher } from '../main/ipc/parcel-watcher-in-process-fallback'
import {
  getVerifiedTerminalArtifactSnapshot,
  readVerifiedTerminalArtifact
} from './fs-handler-terminal-artifact'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const impl = openMock.getMockImplementation()
      return impl ? openMock(...args) : actual.open(...args)
    }
  }
})

function createMockDispatcher() {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  return {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn(),
    notify: vi.fn(),
    notifyClient: vi.fn(),
    onClientDetached: vi.fn(() => () => undefined),
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params)
    }
  }
}

function statIdentity(stats: {
  dev?: number
  ino?: number
  nlink?: number
  size?: number
  mtimeMs?: number
}) {
  return `${stats.dev}:${stats.ino}:${stats.nlink ?? 'unknown'}:${stats.size}:${stats.mtimeMs}`
}

describe('terminal artifact relay handlers', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: FsHandler
  let tmpDir: string

  beforeEach(() => {
    openMock.mockReset()
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-terminal-artifact-'))
    dispatcher = createMockDispatcher()
    handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext(), {
      dispose: vi.fn(),
      forgetRoot: vi.fn(),
      subscribe: subscribeWithInProcessWatcher
    })
  })

  afterEach(async () => {
    handler.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads through a verified artifact handle', async () => {
    const filePath = path.join(tmpDir, 'artifact-read.json')
    writeFileSync(filePath, '{"ok":true}')
    const stats = await fs.stat(filePath)

    await expect(
      dispatcher.callRequest('fs.readTerminalArtifact', {
        filePath,
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: statIdentity(stats),
        maxBytes: 512 * 1024
      })
    ).resolves.toEqual({ content: '{"ok":true}', isBinary: false })
  })

  it('records content digest mismatches', async () => {
    const filePath = path.join(tmpDir, 'artifact-digest.json')
    writeFileSync(filePath, '{"ok":false}')
    const stats = await fs.stat(filePath)

    await expect(
      dispatcher.callRequest('fs.readTerminalArtifact', {
        filePath,
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: statIdentity(stats),
        expectedContentDigest: createHash('sha256').update('{"ok":true}').digest('hex'),
        maxBytes: 512 * 1024
      })
    ).rejects.toMatchObject({
      message: 'terminal_file_grant_stale',
      layer: 'terminal_artifact_grant',
      field: 'content_digest',
      rule: 'sha256_match'
    })
  })

  it('treats SVG artifacts as editable text', async () => {
    const filePath = path.join(tmpDir, 'artifact.svg')
    writeFileSync(filePath, '<svg><text>ok</text></svg>')
    const stats = await fs.stat(filePath)

    await expect(
      dispatcher.callRequest('fs.readTerminalArtifact', {
        filePath,
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: statIdentity(stats),
        maxBytes: 512 * 1024
      })
    ).resolves.toEqual({ content: '<svg><text>ok</text></svg>', isBinary: false })
  })

  it('rejects content beyond the requested byte limit', async () => {
    const filePath = path.join(tmpDir, 'artifact-read-too-large.txt')
    writeFileSync(filePath, 'abcdef')

    await expect(
      dispatcher.callRequest('fs.readTerminalArtifact', {
        filePath,
        expectedRealPath: await fs.realpath(filePath),
        maxBytes: 5
      })
    ).rejects.toThrow('file_too_large')
  })

  it('writes through a verified artifact handle', async () => {
    const filePath = path.join(tmpDir, 'artifact-write.json')
    writeFileSync(filePath, '{"ok":true}')
    const stats = await fs.stat(filePath)

    const result = (await dispatcher.callRequest('fs.writeTerminalArtifact', {
      filePath,
      content: '{"ok":false}',
      expectedRealPath: await fs.realpath(filePath),
      expectedStatIdentity: statIdentity(stats),
      maxBytes: 512 * 1024
    })) as { stat: { type: string; size: number } }

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{"ok":false}')
    expect(result.stat).toMatchObject({ type: 'file', size: 12 })
  })

  it.skipIf(process.platform === 'win32')(
    'preserves executable mode across the atomic rename',
    async () => {
      const filePath = path.join(tmpDir, 'artifact-executable.sh')
      writeFileSync(filePath, '#!/bin/sh\necho ok\n')
      await fs.chmod(filePath, 0o755)
      const stats = await fs.stat(filePath)

      await dispatcher.callRequest('fs.writeTerminalArtifact', {
        filePath,
        content: '#!/bin/sh\necho changed\n',
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: statIdentity(stats),
        maxBytes: 512 * 1024
      })

      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o755)
    }
  )

  it('rejects oversized existing content before writing', async () => {
    const filePath = path.join(tmpDir, 'artifact-write-too-large.txt')
    writeFileSync(filePath, 'abcdef')

    await expect(
      dispatcher.callRequest('fs.writeTerminalArtifact', {
        filePath,
        content: 'ok',
        expectedRealPath: await fs.realpath(filePath),
        maxBytes: 5
      })
    ).rejects.toThrow('file_too_large')
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('abcdef')
  })

  it('clamps client-supplied write limits', async () => {
    const filePath = path.join(tmpDir, 'artifact-write-clamp.txt')
    writeFileSync(filePath, 'abcdef')

    await expect(
      dispatcher.callRequest('fs.writeTerminalArtifact', {
        filePath,
        content: 'a'.repeat(10 * 1024 * 1024 + 1),
        expectedRealPath: await fs.realpath(filePath),
        maxBytes: Number.MAX_SAFE_INTEGER
      })
    ).rejects.toThrow('file_too_large')
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('abcdef')
  })

  it('records relay real-path mismatches before writing outside temp', async () => {
    const filePath = path.join(tmpDir, 'artifact-link.json')
    const outsidePath = path.join(tmpDir, 'outside.json')
    writeFileSync(filePath, '{"ok":true}')
    writeFileSync(outsidePath, '{"secret":true}')
    const stats = await fs.stat(filePath)
    const expectedRealPath = await fs.realpath(filePath)
    await fs.rm(filePath)
    symlinkSync(outsidePath, filePath)

    await expect(
      dispatcher.callRequest('fs.writeTerminalArtifact', {
        filePath,
        content: '{"ok":false}',
        expectedRealPath,
        expectedStatIdentity: statIdentity(stats),
        maxBytes: 512 * 1024
      })
    ).rejects.toMatchObject({
      message: 'terminal_file_grant_stale',
      layer: 'terminal_artifact_grant',
      field: 'relay_real_path',
      rule: 'matches_grant'
    })
    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('{"secret":true}')
  })

  it('records relay hard-link rejections before writing', async () => {
    const outsidePath = path.join(tmpDir, 'outside-hardlink.json')
    const filePath = path.join(tmpDir, 'artifact-hardlink.json')
    writeFileSync(outsidePath, '{"secret":true}')
    await fs.link(outsidePath, filePath)
    const stats = await fs.stat(filePath)

    await expect(
      dispatcher.callRequest('fs.writeTerminalArtifact', {
        filePath,
        content: '{"ok":false}',
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: statIdentity(stats),
        maxBytes: 512 * 1024
      })
    ).rejects.toMatchObject({
      message: 'terminal_file_grant_stale',
      layer: 'terminal_artifact_grant',
      field: 'relay_link_count',
      rule: 'exactly_one'
    })
    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('{"secret":true}')
  })

  it('records relay stat identity mismatches', async () => {
    const filePath = path.join(tmpDir, 'artifact-stat.json')
    writeFileSync(filePath, '{"ok":true}')

    await expect(
      getVerifiedTerminalArtifactSnapshot({
        filePath,
        expectedRealPath: await fs.realpath(filePath),
        expectedStatIdentity: 'different',
        maxBytes: 512 * 1024
      })
    ).rejects.toMatchObject({
      message: 'terminal_file_grant_stale',
      layer: 'terminal_artifact_grant',
      field: 'relay_stat_identity',
      rule: 'matches_grant'
    })
  })

  it('records relay symlink-open races', async () => {
    const filePath = path.join(tmpDir, 'artifact-open-race.json')
    writeFileSync(filePath, '{"ok":true}')
    const expectedRealPath = await fs.realpath(filePath)
    openMock.mockRejectedValueOnce(Object.assign(new Error('ELOOP'), { code: 'ELOOP' }))

    await expect(
      readVerifiedTerminalArtifact({ filePath, expectedRealPath, maxBytes: 512 * 1024 })
    ).rejects.toMatchObject({
      message: 'terminal_file_grant_stale',
      layer: 'terminal_artifact_grant',
      field: 'relay_open',
      rule: 'no_symlink'
    })
  })
})
