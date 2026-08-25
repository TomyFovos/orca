import { describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimCloneTarget,
  cleanupClaimedCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey,
  releaseClaimedCloneTarget
} from './repo-clone-path'

describe('repo clone path helpers', () => {
  it('allows safe repository names that start with two dots', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-path-'))
    try {
      expect(
        deriveValidatedClonePath({
          url: 'https://example.com/..repo.git',
          destination
        })
      ).toBe(join(destination, '..repo'))
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('rejects Windows-looking destinations on non-Windows hosts', async () => {
    if (process.platform === 'win32') {
      return
    }
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: 'C:\\Users\\me\\src'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '\\\\server\\share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//server/share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//wsl.localhost/Ubuntu/home/me'
      })
    ).toThrow('Clone destination must be an absolute path')
  })

  it('canonicalizes WSL UNC server aliases without folding Linux path casing', () => {
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo\\')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).not.toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\user\\repo')
    )
  })

  it('removes only the failed clone directory whose handle it owns', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-ownership-'))
    const clonePath = join(destination, 'repo')
    const claim = await claimCloneTarget(clonePath)
    try {
      await writeFile(join(clonePath, 'partial'), 'failed clone')
      await cleanupClaimedCloneTarget(clonePath, claim)
      await expect(lstat(clonePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await releaseClaimedCloneTarget(claim)
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('preserves a replacement even when saved path identity collides', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-ownership-'))
    const clonePath = join(destination, 'repo')
    const claim = await claimCloneTarget(clonePath)
    try {
      await rm(clonePath, { recursive: true, force: true })
      await mkdir(clonePath)
      await writeFile(join(clonePath, 'replacement'), 'another process')

      const replacementStats = await lstat(clonePath)
      claim.ownedDirectoryIdentity = {
        dev: replacementStats.dev,
        ino: replacementStats.ino,
        birthtimeMs: replacementStats.birthtimeMs
      }
      await cleanupClaimedCloneTarget(clonePath, claim)

      expect(await readFile(join(clonePath, 'replacement'), 'utf8')).toBe('another process')
    } finally {
      await releaseClaimedCloneTarget(claim)
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('releases clone ownership idempotently after success', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-ownership-'))
    const clonePath = join(destination, 'repo')
    const claim = await claimCloneTarget(clonePath)
    try {
      await releaseClaimedCloneTarget(claim)
      await releaseClaimedCloneTarget(claim)
      await writeFile(join(clonePath, 'completed'), 'clone result')
      await cleanupClaimedCloneTarget(clonePath, claim)
      expect(await readFile(join(clonePath, 'completed'), 'utf8')).toBe('clone result')
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })
})
