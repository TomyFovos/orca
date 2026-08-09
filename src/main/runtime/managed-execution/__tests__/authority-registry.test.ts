import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REGISTRY_ENV = 'ORCA_MANAGED_AUTHORITY_REGISTRY_PATH'
const previousRegistryPath = process.env[REGISTRY_ENV]
const temporaryDirectories: string[] = []

function createRegistryFile(authorityId: string, revoked = false): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-authority-registry-test-'))
  temporaryDirectories.push(directory)
  const { publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const filePath = join(directory, 'authorities.json')
  writeFileSync(
    filePath,
    JSON.stringify({
      [authorityId]: { publicKey, revoked }
    })
  )
  return filePath
}

afterEach(() => {
  vi.resetModules()
  if (previousRegistryPath === undefined) {
    delete process.env[REGISTRY_ENV]
  } else {
    process.env[REGISTRY_ENV] = previousRegistryPath
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('managed authority registry', () => {
  it('exports only read-only lookup functions and freezes authority entries', async () => {
    const filePath = createRegistryFile('test-authority')
    process.env[REGISTRY_ENV] = filePath

    const registry = await import('../authority-registry')

    expect(Object.keys(registry).sort()).toEqual([
      'isAuthorityRegistryLoaded',
      'isAuthorityRevoked',
      'lookupAuthority'
    ])
    expect(registry.isAuthorityRegistryLoaded()).toBe(true)
    const authority = registry.lookupAuthority('test-authority')
    expect(authority).toBeDefined()
    expect(Object.isFrozen(authority)).toBe(true)
    expect(registry.isAuthorityRevoked('test-authority')).toBe(false)
    expect(registry.lookupAuthority('missing-authority')).toBeUndefined()
  })

  it('loads the policy once and ignores later environment changes', async () => {
    const firstPath = createRegistryFile('first-authority')
    const secondPath = createRegistryFile('second-authority')
    process.env[REGISTRY_ENV] = firstPath

    const registry = await import('../authority-registry')
    expect(registry.isAuthorityRegistryLoaded()).toBe(true)

    process.env[REGISTRY_ENV] = secondPath
    expect(registry.lookupAuthority('first-authority')).toBeDefined()
    expect(registry.lookupAuthority('second-authority')).toBeUndefined()
  })

  it('remains unloaded when the startup registry path is missing', async () => {
    delete process.env[REGISTRY_ENV]

    const registry = await import('../authority-registry')

    expect(registry.isAuthorityRegistryLoaded()).toBe(false)
    expect(registry.lookupAuthority('test-authority')).toBeUndefined()
  })
})
