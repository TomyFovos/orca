import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path'
import { getProcessRuntimeProfile, MANAGED_ORCA_RUNTIME_PROFILE } from '../runtime-profile'

export const MANAGED_WORKTREE_ROOT_ENV = 'ORCA_MANAGED_WORKTREE_ROOT'

export type ManagedWorktreePlacementRejectionCode =
  | 'unset'
  | 'not_absolute'
  | 'inside_home'
  | 'missing'
  | 'not_a_directory'
  | 'not_traversable'
  | 'not_writable_by_orca'
  | 'host_unvalidatable'

export type ManagedWorktreePlacementRejection = Readonly<{
  code: ManagedWorktreePlacementRejectionCode
  field: string
  rule: string
  detail: string
}>

export class ManagedWorktreePlacementError extends Error {
  readonly code = 'managed_worktree_placement_unavailable'
  readonly rejection: ManagedWorktreePlacementRejection

  constructor(rejection: ManagedWorktreePlacementRejection) {
    super(`Managed worktree placement rejected (${rejection.code}): ${rejection.detail}`)
    this.name = 'ManagedWorktreePlacementError'
    this.rejection = rejection
  }
}

export type ManagedWorktreeRootResolution =
  | { root: string; rejection?: undefined }
  | { root?: undefined; rejection: ManagedWorktreePlacementRejection }

type Resolution = ManagedWorktreeRootResolution

// Why: the env value is startup-fixed like ORCA_RUNTIME_PROFILE, and getWorktreePathSettings runs
// on every watcher rebuild. Only successes are memoized — a rejection is re-evaluated so a root
// that is later created or made traversable is picked up without restarting.
let cachedRoot: { key: string; root: string } | undefined

function reject(
  code: ManagedWorktreePlacementRejectionCode,
  field: string,
  rule: string,
  detail: string
): Resolution {
  return { rejection: { code, field, rule, detail } }
}

function isTraversableByOthers(path: string): boolean {
  // Windows has no POSIX mode bits; the isolated-worker UID model this guards is POSIX-only.
  if (process.platform === 'win32') {
    return true
  }
  return (statSync(path).mode & 0o001) !== 0
}

function findNonTraversableAncestor(root: string): string | undefined {
  let current = root
  for (;;) {
    if (!isTraversableByOthers(current)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    current = parent
  }
}

function isInsideOrEqual(target: string, base: string): boolean {
  if (target === base) {
    return true
  }
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve the managed-profile worktree root from configuration, validating that an isolated
 * worker running under a foreign UID can traverse into it. Never falls back to a default:
 * an unresolved or unreachable root is a rejection carrying the reason it was rejected.
 *
 * Traversability is necessary but not sufficient — Orca cannot decide whether the worker's UID
 * may write inside the root, because fs.access answers for the calling process only.
 */
export function resolveManagedWorktreeRoot(env: NodeJS.ProcessEnv = process.env): Resolution {
  const configured = env[MANAGED_WORKTREE_ROOT_ENV]?.trim()
  if (!configured) {
    return reject(
      'unset',
      MANAGED_WORKTREE_ROOT_ENV,
      'required-in-managed-profile',
      `${MANAGED_WORKTREE_ROOT_ENV} is not set; managed profile has no default worktree root`
    )
  }

  if (cachedRoot?.key === configured) {
    return { root: cachedRoot.root }
  }

  if (!isAbsolute(configured)) {
    return reject(
      'not_absolute',
      MANAGED_WORKTREE_ROOT_ENV,
      'absolute-path',
      `${configured} is not an absolute path`
    )
  }

  let real: string
  try {
    real = realpathSync(normalize(configured))
  } catch {
    return reject(
      'missing',
      MANAGED_WORKTREE_ROOT_ENV,
      'exists',
      `${configured} does not exist or cannot be resolved`
    )
  }

  try {
    if (!statSync(real).isDirectory()) {
      return reject('not_a_directory', MANAGED_WORKTREE_ROOT_ENV, 'is-directory', `${real}`)
    }
  } catch {
    return reject('missing', MANAGED_WORKTREE_ROOT_ENV, 'exists', `${real}`)
  }

  // Why: symlinks are resolved first so a link pointing back into $HOME cannot pass this check.
  const home = env.HOME || env.USERPROFILE
  if (home) {
    let realHome = home
    try {
      realHome = realpathSync(home)
    } catch {
      realHome = normalize(home)
    }
    if (isInsideOrEqual(real, realHome)) {
      return reject(
        'inside_home',
        MANAGED_WORKTREE_ROOT_ENV,
        'outside-home',
        `${real} is inside ${realHome}; an isolated worker cannot traverse a 700 home`
      )
    }
  }

  let blocked: string | undefined
  try {
    blocked = findNonTraversableAncestor(real)
  } catch {
    return reject(
      'not_traversable',
      MANAGED_WORKTREE_ROOT_ENV,
      'ancestors-world-traversable',
      `an ancestor of ${real} could not be inspected`
    )
  }
  if (blocked) {
    return reject(
      'not_traversable',
      MANAGED_WORKTREE_ROOT_ENV,
      'ancestors-world-traversable',
      `${blocked} lacks o+x; the isolated worker cannot reach ${real}. Relocate the root — do not loosen permissions`
    )
  }

  try {
    accessSync(real, constants.W_OK | constants.X_OK)
  } catch {
    return reject(
      'not_writable_by_orca',
      MANAGED_WORKTREE_ROOT_ENV,
      'writable-by-orca',
      `${real} is not writable by the Orca process`
    )
  }

  cachedRoot = { key: configured, root: real }
  return { root: real }
}

/** Non-throwing form for read paths (watchers, path authorization). Never falls back to $HOME. */
export function getManagedWorktreeRootOrNull(env: NodeJS.ProcessEnv = process.env): string | null {
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return null
  }
  return resolveManagedWorktreeRoot(env).root ?? null
}

function logRejection(operation: string, rejection: ManagedWorktreePlacementRejection): void {
  console.error(
    `[managed-worktree] Placement rejected: operation=${operation} code=${rejection.code} field=${rejection.field} rule=${rejection.rule} detail=${rejection.detail}`
  )
}

/**
 * Fail-closed gate for worktree creation. In the default profile this is a no-op; in managed it
 * throws unless a reachable root is configured, recording why it refused.
 */
export function assertManagedWorktreePlacement(
  operation: string,
  options: { hostUnvalidatable?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env
): void {
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return
  }

  if (options.hostUnvalidatable) {
    // Why: the root would live on the SSH host, where none of the checks above can run. Placing
    // it beside the remote repo means placing it in the remote $HOME — the hole this policy closes.
    const rejection: ManagedWorktreePlacementRejection = {
      code: 'host_unvalidatable',
      field: 'repo.path',
      rule: 'local-posix-host-only',
      detail:
        'managed worktree placement cannot be validated on a remote host; remote worktree creation is refused in the managed profile'
    }
    logRejection(operation, rejection)
    throw new ManagedWorktreePlacementError(rejection)
  }

  const resolution = resolveManagedWorktreeRoot(env)
  if (resolution.rejection) {
    logRejection(operation, resolution.rejection)
    throw new ManagedWorktreePlacementError(resolution.rejection)
  }
}
