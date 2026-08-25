import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../../shared/cross-platform-path'

export type ClaimedCloneTarget = {
  canCleanup: boolean
  ownedDirectoryIdentity: CloneDirectoryIdentity | null
  ownershipHandle: FileHandle | null
}

type CloneDirectoryIdentity = Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>

export function deriveCloneRepoNameFromUrl(url: string): string {
  // Why: direct callers can supply URLs whose default git clone folder would
  // be "." or ".."; rejecting them prevents parent/destination deletion.
  const source = url.replace(/\.git\/?$/, '')
  const isWindowsLocalSource = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\')
  const repoName = isWindowsLocalSource ? win32.basename(source) : posix.basename(source)
  if (!repoName || repoName === '.' || repoName === '..') {
    throw new Error('Invalid repository name derived from URL')
  }
  if (repoName.includes('/') || repoName.includes('\\')) {
    throw new Error('Invalid repository name derived from URL')
  }
  return repoName
}

export function deriveValidatedClonePath(args: { url: string; destination: string }): string {
  if (
    !args.destination ||
    !isAbsolute(args.destination) ||
    (process.platform !== 'win32' && isWindowsAbsolutePathLike(args.destination))
  ) {
    throw new Error('Clone destination must be an absolute path')
  }

  const repoName = deriveCloneRepoNameFromUrl(args.url)

  const clonePath = join(args.destination, repoName)
  const resolvedDestination = resolve(args.destination)
  const resolvedClonePath = resolve(clonePath)
  const pathFromDestination = relative(resolvedDestination, resolvedClonePath)
  if (
    pathFromDestination === '' ||
    pathFromDestination === '..' ||
    pathFromDestination.startsWith(`..${sep}`) ||
    isAbsolute(pathFromDestination)
  ) {
    throw new Error('Clone path must be inside the destination directory')
  }

  return clonePath
}

export function getClonePathComparisonKey(clonePath: string): string {
  const resolvedClonePath = isWindowsAbsolutePathLike(clonePath) ? clonePath : resolve(clonePath)
  const normalized = normalizeRuntimePathSeparators(resolvedClonePath)
  const wslUncMatch = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (wslUncMatch) {
    // Why: WSL UNC paths cross into a case-sensitive Linux filesystem, so only
    // the Windows UNC server alias and distro segment should be case-folded.
    const linuxPath = (wslUncMatch[2] ?? '').replace(/\/+$/, '')
    return `//wsl/${wslUncMatch[1].toLowerCase()}${linuxPath}`
  }
  return normalizeRuntimePathForComparison(resolvedClonePath)
}

export async function claimCloneTarget(clonePath: string): Promise<ClaimedCloneTarget> {
  try {
    await mkdir(clonePath, { recursive: false })
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      return { canCleanup: false, ownedDirectoryIdentity: null, ownershipHandle: null }
    }
    throw error
  }

  let ownershipHandle: FileHandle | null = null
  try {
    // Why: keeping the directory open pins its filesystem object, so a later
    // remove/recreate cannot impersonate it through inode reuse.
    ownershipHandle = await open(clonePath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    const [ownedStats, currentStats] = await Promise.all([ownershipHandle.stat(), lstat(clonePath)])
    if (
      !ownedStats.isDirectory() ||
      !currentStats.isDirectory() ||
      !isSameCloneDirectoryIdentity(
        cloneDirectoryIdentity(ownedStats),
        cloneDirectoryIdentity(currentStats)
      )
    ) {
      throw new Error('Clone target ownership changed while it was being claimed')
    }
    return {
      canCleanup: true,
      ownedDirectoryIdentity: cloneDirectoryIdentity(ownedStats),
      ownershipHandle
    }
  } catch (error) {
    await ownershipHandle?.close().catch(() => undefined)
    // Do not remove the path here: without an established handle it may
    // already belong to another process.
    throw error
  }
}

export async function cleanupClaimedCloneTarget(
  clonePath: string,
  claimedTarget: ClaimedCloneTarget
): Promise<void> {
  if (
    !claimedTarget.canCleanup ||
    !claimedTarget.ownedDirectoryIdentity ||
    !claimedTarget.ownershipHandle
  ) {
    return
  }

  let quarantineRoot: string | null = null
  let quarantinedTarget: string | null = null
  let targetMoved = false
  try {
    const [ownedStats, currentStats] = await Promise.all([
      claimedTarget.ownershipHandle.stat(),
      lstat(clonePath)
    ])
    if (
      !ownedStats.isDirectory() ||
      !currentStats.isDirectory() ||
      !isSameCloneDirectoryIdentity(
        cloneDirectoryIdentity(ownedStats),
        cloneDirectoryIdentity(currentStats)
      )
    ) {
      console.warn('[git:clone-cleanup] Refused cleanup because clone target ownership changed', {
        clonePath
      })
      return
    }

    // Why: isolate the exact directory before recursive deletion; a new path
    // created at clonePath after this rename is never inside the deletion root.
    quarantineRoot = await mkdtemp(join(dirname(clonePath), '.orca-clone-cleanup-'))
    quarantinedTarget = join(quarantineRoot, 'target')
    await rename(clonePath, quarantinedTarget)
    targetMoved = true

    const quarantinedStats = await lstat(quarantinedTarget)
    if (
      !isSameCloneDirectoryIdentity(
        cloneDirectoryIdentity(ownedStats),
        cloneDirectoryIdentity(quarantinedStats)
      )
    ) {
      // A replacement won the narrow check-to-rename race. Preserve it in the
      // quarantine directory rather than recursively deleting unknown data.
      console.warn(
        '[git:clone-cleanup] Refused cleanup because ownership changed during isolation',
        { clonePath, preservedPath: quarantinedTarget }
      )
      return
    }

    await releaseClaimedCloneTarget(claimedTarget)
    await rm(quarantineRoot, { recursive: true, force: true })
    quarantineRoot = null
    quarantinedTarget = null
    targetMoved = false
  } catch (error) {
    console.warn('[git:clone-cleanup] Refused or failed clone target cleanup', {
      clonePath,
      preservedPath: quarantinedTarget,
      reason: error instanceof Error ? error.message : String(error)
    })
  } finally {
    await releaseClaimedCloneTarget(claimedTarget)
    if (quarantineRoot && !targetMoved) {
      await rmdir(quarantineRoot).catch(() => undefined)
    }
  }
}

export async function releaseClaimedCloneTarget(claimedTarget: ClaimedCloneTarget): Promise<void> {
  const ownershipHandle = claimedTarget.ownershipHandle
  claimedTarget.ownershipHandle = null
  await ownershipHandle?.close().catch(() => undefined)
}

function cloneDirectoryIdentity(stats: Stats): CloneDirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs }
}

function isSameCloneDirectoryIdentity(
  a: CloneDirectoryIdentity,
  b: CloneDirectoryIdentity
): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
