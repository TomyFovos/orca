import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getProcessRuntimeProfile, MANAGED_ORCA_RUNTIME_PROFILE } from '../runtime-profile'

export type ManagedWorkerGitIsolationRejection = Readonly<{
  code: 'git_metadata_reachable' | 'git_metadata_unresolvable'
  layer: 'managed_worker_git_isolation'
  field: string
  rule: string
  detail: string
}>

export const MANAGED_WORKER_GIT_ISOLATION_ERROR_CODE = 'managed_worker_git_isolation_required'

export class ManagedWorkerGitIsolationError extends Error {
  readonly code = MANAGED_WORKER_GIT_ISOLATION_ERROR_CODE
  readonly data: ManagedWorkerGitIsolationRejection

  constructor(rejection: ManagedWorkerGitIsolationRejection) {
    super(`Managed worker Git isolation rejected (${rejection.code}): ${rejection.detail}`)
    this.name = 'ManagedWorkerGitIsolationError'
    this.data = rejection
  }
}

function reject(
  code: ManagedWorkerGitIsolationRejection['code'],
  field: string,
  rule: string,
  detail: string
): never {
  const rejection: ManagedWorkerGitIsolationRejection = {
    code,
    layer: 'managed_worker_git_isolation',
    field,
    rule,
    detail
  }
  console.error(
    `[managed-worker-git-isolation] Rejected: layer=${rejection.layer} code=${rejection.code} field=${rejection.field} rule=${rejection.rule} detail=${rejection.detail}`
  )
  throw new ManagedWorkerGitIsolationError(rejection)
}

function findNonTraversableAncestor(path: string): string | undefined {
  let current = path
  for (;;) {
    if ((statSync(current).mode & 0o001) === 0) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    current = parent
  }
}

function gitDiscoveryEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      environment[key] = value
    }
  }
  // Why: a caller-controlled Git environment can redirect discovery away from the worker workspace.
  return { ...environment, LC_ALL: 'C', LANG: 'C' }
}

function isNotGitRepository(error: unknown): boolean {
  const gitError = error as NodeJS.ErrnoException & { status?: number; stderr?: string | Buffer }
  const stderr = typeof gitError.stderr === 'string' ? gitError.stderr : gitError.stderr?.toString()
  return gitError.status === 128 && stderr?.includes('not a git repository') === true
}

function resolveGitMetadataPaths(worktreePath: string): string[] {
  let output: string
  try {
    output = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      env: gitDiscoveryEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000
    })
  } catch (error) {
    if (isNotGitRepository(error)) {
      return []
    }
    reject(
      'git_metadata_unresolvable',
      worktreePath,
      'git-repository-discovery',
      'Git could not resolve the repository metadata for this workspace'
    )
  }
  const lines = output.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  const commonDirPath = lines.length === 1 ? lines[0]?.replace(/\r$/, '') : undefined
  if (!commonDirPath) {
    reject(
      'git_metadata_unresolvable',
      worktreePath,
      'git-repository-discovery-output',
      'Git returned an uninterpretable common metadata directory'
    )
  }
  const commonDir = realpathSync(resolve(worktreePath, commonDirPath))
  if (!statSync(commonDir).isDirectory()) {
    reject(
      'git_metadata_unresolvable',
      commonDir,
      'git-common-dir-directory',
      'Git resolved common metadata that is not a directory'
    )
  }
  // Why: linked worktrees share this common dir, so an agent bypassing its own sandbox could rewrite every worktree's refs.
  return [commonDir]
}

/**
 * Refuse to hand a managed worker a workspace when the foreign UID can traverse to Git metadata.
 * A folder workspace has no discovered repository; discovery failures are rejected because isolation cannot be established.
 */
export function assertManagedWorkerGitIsolated(
  worktreePath: string,
  options: { hostUnvalidatable?: boolean } = {}
): void {
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return
  }
  if (process.platform === 'win32') {
    reject(
      'git_metadata_unresolvable',
      worktreePath,
      'posix-o+x-required',
      'Windows does not expose the POSIX o+x reachability criterion required for managed worker isolation'
    )
  }
  if (options.hostUnvalidatable) {
    reject(
      'git_metadata_unresolvable',
      worktreePath,
      'local-posix-host-only',
      'Git metadata isolation cannot be validated on a remote host'
    )
  }
  // Why: agents can bypass their own approvals and sandbox, so Orca must enforce metadata isolation before spawn.
  let metadataPaths: string[]
  try {
    metadataPaths = resolveGitMetadataPaths(worktreePath)
  } catch (error) {
    if (error instanceof ManagedWorkerGitIsolationError) {
      throw error
    }
    reject(
      'git_metadata_unresolvable',
      worktreePath,
      'git-metadata-resolvable',
      'Git metadata could not be resolved'
    )
  }
  for (const metadataPath of metadataPaths) {
    let blocked: string | undefined
    try {
      blocked = findNonTraversableAncestor(metadataPath)
    } catch {
      reject(
        'git_metadata_unresolvable',
        metadataPath,
        'ancestors-world-traversable',
        'a Git metadata ancestor could not be inspected'
      )
    }
    if (!blocked) {
      reject(
        'git_metadata_reachable',
        metadataPath,
        'ancestors-not-world-traversable',
        `${metadataPath} is reachable through o+x ancestors by the isolated worker UID`
      )
    }
  }
}
