import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import type { ManagedWorktreePlacementIpcFailure } from '../shared/worktree-create-ipc'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

describe('worktree creation preload IPC', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    send.mockReset()
    sendSync.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  it('passes structured managed placement failures through unchanged', async () => {
    const failure: ManagedWorktreePlacementIpcFailure = {
      kind: 'managed_worktree_placement_rejected',
      code: 'managed_worktree_placement_unavailable',
      data: {
        code: 'not_traversable',
        field: 'ORCA_MANAGED_WORKTREE_ROOT',
        rule: 'ancestors-world-traversable',
        detail: 'the isolated worker cannot reach the configured root'
      },
      message: 'Managed worktree placement rejected (not_traversable)'
    }
    const args = { repoId: 'repo-1', name: 'workspace' }
    invoke.mockResolvedValueOnce(failure)

    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    await expect(api.worktrees.create(args)).rejects.toEqual(failure)
    expect(invoke).toHaveBeenCalledWith('worktrees:create', args)
  })
})
