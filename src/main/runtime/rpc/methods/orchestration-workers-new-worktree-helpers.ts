import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createOrchestrationWorkerStartMethods } from './orchestration-workers'

// Reachability tests must not inherit a caller TMPDIR below a non-traversable home directory.
const reachableTempRoot = process.platform === 'win32' ? tmpdir() : '/tmp'

export function createNewWorktreeTestHelpers(context: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
}) {
  const managedWorkerStartMethod = createOrchestrationWorkerStartMethods(() => 'managed').find(
    (candidate) => candidate.name === 'orchestration.workerStart'
  )!

  async function startWorker(
    overrides: Record<string, unknown> = {},
    method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
  ) {
    const task = context.db.createTask({ spec: 'new-worktree task', runId: context.runId })
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'new-child',
      name: 'new-worker',
      agent: 'codex',
      ...overrides
    })
    const result = await method.handler(params, { runtime: context.runtime })
    return { result, task }
  }

  async function startExistingWorktreeWorker(
    overrides: Record<string, unknown> = {},
    method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
  ) {
    const task = context.db.createTask({ spec: 'existing-worktree task', runId: context.runId })
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'current',
      agent: 'codex',
      ...overrides
    })
    const result = await method.handler(params, { runtime: context.runtime })
    return { result, task }
  }

  function mockCreatedWorktree(options?: {
    hookFound?: boolean
    startupPolicy?: 'start-immediately' | 'wait-for-setup'
    state?: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminals?: { handle: string; title: string }[]
    setupTerminalHandle?: string
  }) {
    const hookFound = options?.hookFound ?? true
    const state = options?.state ?? (hookFound ? 'running' : 'not_configured')
    vi.spyOn(context.runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: state === 'skipped' ? 'skip' : 'run',
        hookFound,
        startupPolicy: options?.startupPolicy ?? 'start-immediately',
        state,
        terminalHandle:
          options?.setupTerminalHandle ??
          options?.terminals?.find((terminal) => terminal.title === 'Setup')?.handle
      }
    } as never)
    if (options?.terminals) {
      vi.mocked(context.runtime.listTerminals).mockResolvedValue({
        terminals: options.terminals,
        totalCount: options.terminals.length,
        truncated: false
      } as never)
    }
  }

  function configureReachableLinkedGitdir() {
    const base = mkdtempSync(join(reachableTempRoot, 'orca-worker-start-git-'))
    chmodSync(base, 0o755)
    const repository = join(base, 'repository')
    const worktreePath = join(base, 'worktree')
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
    execFileSync('git', ['worktree', 'add', '--detach', '-q', worktreePath, 'HEAD'], {
      cwd: repository
    })
    return { base, commonDir: join(repository, '.git'), worktreePath }
  }

  return {
    configureReachableLinkedGitdir,
    managedWorkerStartMethod,
    mockCreatedWorktree,
    startExistingWorktreeWorker,
    startWorker,
    removeTemporaryGitFixture: (base: string) => rmSync(base, { recursive: true, force: true })
  }
}
