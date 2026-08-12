import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
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

function resolveLinkedGitdir(gitFile: string): string {
  const content = readFileSync(gitFile, 'utf8')
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
  if (!match?.[1]) {
    reject(
      'git_metadata_unresolvable',
      gitFile,
      'linked-gitdir-pointer',
      'the .git file is not a gitdir pointer'
    )
  }
  const target = match[1]
  return realpathSync(isAbsolute(target) ? target : resolve(dirname(gitFile), target))
}

function resolveCommonGitdir(gitdir: string): string {
  const commonDirFile = resolve(gitdir, 'commondir')
  const target = readFileSync(commonDirFile, 'utf8').trim()
  if (!target) {
    reject(
      'git_metadata_unresolvable',
      commonDirFile,
      'linked-common-dir-pointer',
      'the linked gitdir has no common-dir pointer'
    )
  }
  const commonDir = realpathSync(
    isAbsolute(target) ? target : resolve(dirname(commonDirFile), target)
  )
  if (!statSync(commonDir).isDirectory()) {
    reject(
      'git_metadata_unresolvable',
      commonDir,
      'linked-common-dir-directory',
      'the linked common dir is not a directory'
    )
  }
  return commonDir
}

function resolveGitMetadataPaths(worktreePath: string): string[] {
  const gitPath = resolve(worktreePath, '.git')
  let gitStat: ReturnType<typeof statSync>
  try {
    gitStat = statSync(gitPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    reject(
      'git_metadata_unresolvable',
      gitPath,
      'git-metadata-stat',
      'the .git path could not be inspected'
    )
  }
  if (gitStat.isDirectory()) {
    return [realpathSync(gitPath)]
  }
  if (!gitStat.isFile()) {
    reject(
      'git_metadata_unresolvable',
      gitPath,
      'git-metadata-kind',
      'the .git path is neither a file nor a directory'
    )
  }
  const gitdir = resolveLinkedGitdir(gitPath)
  if (!statSync(gitdir).isDirectory()) {
    reject(
      'git_metadata_unresolvable',
      gitdir,
      'linked-gitdir-directory',
      'the linked gitdir is not a directory'
    )
  }
  // Why: linked worktrees share this common dir, so an agent bypassing its own sandbox could rewrite every worktree's refs.
  return [gitdir, resolveCommonGitdir(gitdir)]
}

/**
 * Refuse to hand a managed worker a workspace when the foreign UID can traverse to Git metadata.
 * A folder workspace has no .git metadata, but malformed metadata is rejected because isolation cannot be established.
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
  let metadataPaths: string[]
  try {
    metadataPaths = resolveGitMetadataPaths(worktreePath)
  } catch (error) {
    if (error instanceof ManagedWorkerGitIsolationError) {
      throw error
    }
    reject(
      'git_metadata_unresolvable',
      resolve(worktreePath, '.git'),
      'git-metadata-resolvable',
      'the .git metadata path could not be resolved'
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
