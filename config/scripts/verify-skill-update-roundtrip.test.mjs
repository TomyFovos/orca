import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const VERIFIER = path.join(REPO_ROOT, 'config', 'scripts', 'verify-skill-update-roundtrip.mjs')
const temporaryRoots = []

async function createMissingTagFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-skill-update-missing-tag-'))
  temporaryRoots.push(root)
  const gitDirectory = path.join(root, 'git')
  const binDirectory = path.join(root, 'bin')
  const markerPath = path.join(root, 'npx-invoked')
  await mkdir(binDirectory)
  execFileSync('git', ['init', '--bare', '--quiet', gitDirectory])

  const trap = `
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.ORCA_NPX_MARKER, 'invoked\\n')
process.exit(91)
`
  if (process.platform === 'win32') {
    await writeFile(path.join(binDirectory, 'npx-trap.cjs'), trap)
    await writeFile(
      path.join(binDirectory, 'npx.cmd'),
      '@echo off\r\nnode "%~dp0npx-trap.cjs" %*\r\n'
    )
  } else {
    await writeFile(path.join(binDirectory, 'npx'), `#!/usr/bin/env node\n${trap}`)
    await chmod(path.join(binDirectory, 'npx'), 0o755)
  }

  return { binDirectory, gitDirectory, markerPath, root }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('skill update round-trip missing-tag refusal', () => {
  it('refuses the exact missing tag before invoking the updater', async () => {
    const fixture = await createMissingTagFixture()
    const result = spawnSync(
      process.execPath,
      [VERIFIER, '--cli=1.5.17', '--autocrlf=false', '--shape=symlink'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_DIR: fixture.gitDirectory,
          HOME: path.join(fixture.root, 'home'),
          ORCA_NPX_MARKER: fixture.markerPath,
          PATH: `${fixture.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
          SKILL_UPDATE_REF: 'fixture-ref',
          SKILL_UPDATE_SOURCE: 'fixture/source',
          USERPROFILE: path.join(fixture.root, 'home')
        }
      }
    )
    const stderr = result.stderr.replaceAll('\r\n', '\n')

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(stderr).toBe(
      '[skill-update-roundtrip] refused: required historical tag refs/tags/v1.4.148 is missing for orca-cli\n'
    )
    expect(stderr).not.toContain('Not a valid object name')
    expect(stderr).not.toContain('node:internal')
    expect(existsSync(fixture.markerPath)).toBe(false)
  })
})
