import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setProcessRuntimeProfile } from '../../runtime-profile'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'managed-execution-worktree', authToken: 'tok', method, params }
}

const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('managed execution worktree boundaries', () => {
  afterEach(() => {
    setProcessRuntimeProfile('default')
  })

  it('rejects managed worktree removal before the runtime effect', async () => {
    setProcessRuntimeProfile('managed')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      removeManagedWorktree: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.rm', { worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'managed_execution_authorization_required' }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects managed target CLI startup before the runtime effect', async () => {
    setProcessRuntimeProfile('managed')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn(),
      createManagedWorktree: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'managed-worker',
        startupAgent: 'codex'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'managed_execution_authorization_required' }
    })
    expect(runtime.showRepo).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
