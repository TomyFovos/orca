import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcFailure } from '../../rpc/core'
import { mapRuntimeError } from '../../rpc/errors'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'
import {
  assertManagedWorkerGitIsolated,
  ManagedWorkerGitIsolationError,
  type ManagedWorkerGitIsolationRejection
} from '../managed-worker-git-isolation'

const isPosix = process.platform !== 'win32'
const createdTempDirs: string[] = []

function makeReachableBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'orca-managed-worker-git-'))
  createdTempDirs.push(base)
  chmodSync(base, 0o755)
  return base
}

function makeLinkedWorktree(): { commonDir: string; worktree: string } {
  const base = makeReachableBase()
  const commonDir = join(base, 'repository.git')
  const gitdir = join(commonDir, 'worktrees', 'worker')
  const worktree = join(base, 'worktree')
  mkdirSync(gitdir, { recursive: true, mode: 0o755 })
  mkdirSync(worktree, { mode: 0o755 })
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`)
  return { commonDir, worktree }
}

afterEach(() => {
  setProcessRuntimeProfile('default')
  vi.restoreAllMocks()
  while (createdTempDirs.length > 0) {
    rmSync(createdTempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('managed worker Git isolation', () => {
  beforeEach(() => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it.skipIf(!isPosix)('rejects a linked worktree whose gitdir and common dir are reachable', () => {
    const { commonDir, worktree } = makeLinkedWorktree()

    expect(() => assertManagedWorkerGitIsolated(worktree)).toThrow(ManagedWorkerGitIsolationError)
    try {
      assertManagedWorkerGitIsolated(worktree)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'managed_worker_git_isolation_required',
        data: {
          code: 'git_metadata_reachable',
          layer: 'managed_worker_git_isolation',
          field: expect.stringContaining(commonDir),
          rule: 'ancestors-not-world-traversable'
        }
      })
    }
  })

  it.skipIf(!isPosix)('allows a linked worktree when the shared common dir lacks o+x', () => {
    const { commonDir, worktree } = makeLinkedWorktree()
    chmodSync(commonDir, 0o700)

    expect(() => assertManagedWorkerGitIsolated(worktree)).not.toThrow()
  })

  it('allows a folder workspace with no .git metadata', () => {
    const workspace = makeReachableBase()

    expect(() => assertManagedWorkerGitIsolated(workspace)).not.toThrow()
  })

  it.skipIf(!isPosix)('allows a primary worktree when its .git directory lacks o+x', () => {
    const workspace = makeReachableBase()
    const gitDirectory = join(workspace, '.git')
    mkdirSync(gitDirectory, { mode: 0o700 })

    expect(() => assertManagedWorkerGitIsolated(workspace)).not.toThrow()
  })

  it('rejects malformed git metadata and preserves layer, field, and rule through RPC', () => {
    const workspace = makeReachableBase()
    writeFileSync(join(workspace, '.git'), 'not a gitdir pointer\n')
    let thrown: unknown

    try {
      assertManagedWorkerGitIsolated(workspace)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ManagedWorkerGitIsolationError)
    const rpcError: RpcFailure['error'] = mapRuntimeError(
      'req_1',
      { runtimeId: 'runtime-1' },
      thrown
    ).error
    expect(rpcError).toMatchObject({
      code: 'managed_worker_git_isolation_required',
      data: {
        code: 'git_metadata_unresolvable',
        layer: 'managed_worker_git_isolation',
        field: join(workspace, '.git'),
        rule: 'linked-gitdir-pointer'
      }
    })
    expect((rpcError.data as ManagedWorkerGitIsolationRejection).detail).toBeTruthy()
  })
})
