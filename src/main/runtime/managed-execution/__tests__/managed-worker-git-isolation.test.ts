import { execFileSync } from 'node:child_process'
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
const profileState = vi.hoisted(() => ({ value: 'default' as 'default' | 'managed' }))

vi.mock('../../runtime-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-profile')>()
  return {
    ...actual,
    getProcessRuntimeProfile: () => profileState.value,
    setProcessRuntimeProfile: (profile: 'default' | 'managed') => {
      profileState.value = profile
    }
  }
})

function makeReachableBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'orca-managed-worker-git-'))
  createdTempDirs.push(base)
  chmodSync(base, 0o755)
  return base
}

function makeLinkedWorktree(): { commonDir: string; worktree: string } {
  const base = makeReachableBase()
  const repository = join(base, 'repository')
  const worktree = join(base, 'worktree')
  mkdirSync(repository, { mode: 0o755 })
  execFileSync('git', ['init', '-q'], { cwd: repository })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'fixture'], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Orca Test',
      GIT_AUTHOR_EMAIL: 'orca-test@example.invalid',
      GIT_COMMITTER_NAME: 'Orca Test',
      GIT_COMMITTER_EMAIL: 'orca-test@example.invalid'
    }
  })
  execFileSync('git', ['worktree', 'add', '--detach', '-q', worktree, 'HEAD'], { cwd: repository })
  return { commonDir: join(repository, '.git'), worktree }
}

afterEach(() => {
  setProcessRuntimeProfile('default')
  vi.unstubAllEnvs()
  // Keep Vitest's global expect extensions (including jest-dom) intact for
  // renderer files that may share this worker. Restore only the spies owned by
  // this file instead of resetting the global mock registry.
  vi.mocked(console.error).mockRestore()
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

  it('does not let caller Git environment variables redirect folder discovery', () => {
    const workspace = makeReachableBase()
    const { commonDir, worktree } = makeLinkedWorktree()
    vi.stubEnv('GIT_DIR', commonDir)
    vi.stubEnv('GIT_WORK_TREE', worktree)
    vi.stubEnv('GIT_CEILING_DIRECTORIES', workspace)

    expect(() => assertManagedWorkerGitIsolated(workspace)).not.toThrow()
  })

  it.skipIf(!isPosix)('rejects a folder workspace nested below a reachable repository', () => {
    const { commonDir, worktree } = makeLinkedWorktree()
    const nestedFolder = join(worktree, 'folder-workspace')
    mkdirSync(nestedFolder, { mode: 0o755 })

    expect(() => assertManagedWorkerGitIsolated(nestedFolder)).toThrow(
      ManagedWorkerGitIsolationError
    )
    try {
      assertManagedWorkerGitIsolated(nestedFolder)
    } catch (error) {
      expect(error).toMatchObject({
        data: {
          code: 'git_metadata_reachable',
          field: commonDir,
          rule: 'ancestors-not-world-traversable'
        }
      })
    }
  })

  it.skipIf(!isPosix)('allows a primary worktree when its .git directory lacks o+x', () => {
    const workspace = makeReachableBase()
    const gitDirectory = join(workspace, '.git')
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    chmodSync(gitDirectory, 0o700)

    expect(() => assertManagedWorkerGitIsolated(workspace)).not.toThrow()
  })

  it('rejects an unresolvable Git repository and preserves layer, field, and rule through RPC', () => {
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
        field: workspace,
        rule: 'git-repository-discovery'
      }
    })
    expect((rpcError.data as ManagedWorkerGitIsolationRejection).detail).toBeTruthy()
  })

  it('rejects an SSH-host workspace as unresolvable without calling it reachable', () => {
    const workspace = makeReachableBase()

    expect(() => assertManagedWorkerGitIsolated(workspace, { hostUnvalidatable: true })).toThrow(
      ManagedWorkerGitIsolationError
    )
    try {
      assertManagedWorkerGitIsolated(workspace, { hostUnvalidatable: true })
    } catch (error) {
      expect(error).toMatchObject({
        data: {
          code: 'git_metadata_unresolvable',
          rule: 'local-posix-host-only',
          detail: expect.stringContaining('cannot be validated on a remote host')
        }
      })
    }
  })

  it('rejects a Windows workspace as unresolvable without calling it reachable', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const workspace = makeReachableBase()

    expect(() => assertManagedWorkerGitIsolated(workspace)).toThrow(ManagedWorkerGitIsolationError)
    try {
      assertManagedWorkerGitIsolated(workspace)
    } catch (error) {
      expect(error).toMatchObject({
        data: {
          code: 'git_metadata_unresolvable',
          rule: 'posix-o+x-required',
          detail: expect.stringContaining('does not expose the POSIX o+x')
        }
      })
    } finally {
      platform.mockRestore()
    }
  })
})
