import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const AUTHORITY_REGISTRY_ENV = 'ORCA_MANAGED_AUTHORITY_REGISTRY_PATH'

export type AuthorityInfo = Readonly<{
  publicKey: string
  revoked: boolean
}>

// The registry is intentionally process-private. It is populated once during
// startup and never exposes a mutable collection or a runtime registration API.
let registry: ReadonlyMap<string, AuthorityInfo> = new Map()
let registryInitialized = false
let registryLoaded = false

/**
 * Read the startup policy on first access. There is deliberately no exported
 * loader, registration, revocation, or mutable-map accessor: changing the
 * policy requires changing the file and restarting Orca.
 *
 * A registry entry grants the holder of the corresponding private key managed
 * execution authority. Keep this file protected like an authorization policy;
 * adding an entry is equivalent to granting execution permission.
 */
function initializeAuthorityRegistry(): void {
  if (registryInitialized) {
    return
  }
  registryInitialized = true

  const configPath = process.env[AUTHORITY_REGISTRY_ENV]
  if (!configPath) {
    console.error(
      `[managed-execution] ${AUTHORITY_REGISTRY_ENV} is not set; managed endpoint will not start`
    )
    return
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const entries = parseAuthorityRegistryDocument(parsed)
    if (entries.length === 0) {
      throw new Error('Authority registry must contain at least one authority')
    }

    registry = new Map(entries)
    registryLoaded = true
  } catch (error) {
    console.error(
      `[managed-execution] Failed to load authority registry from ${configPath}; managed endpoint will not start:`,
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function isAuthorityRegistryLoaded(): boolean {
  initializeAuthorityRegistry()
  return registryLoaded
}

export function lookupAuthority(authorityId: string): AuthorityInfo | undefined {
  initializeAuthorityRegistry()
  return registry.get(authorityId)
}

export function isAuthorityRevoked(authorityId: string): boolean {
  initializeAuthorityRegistry()
  return registry.get(authorityId)?.revoked ?? false
}

function parseAuthorityRegistryDocument(value: unknown): [string, AuthorityInfo][] {
  if (!isRecord(value)) {
    throw new Error('Authority registry must be a JSON object')
  }

  const entries: [string, AuthorityInfo][] = []
  for (const [authorityId, rawEntry] of Object.entries(value)) {
    if (!authorityId || !isRecord(rawEntry) || typeof rawEntry.publicKey !== 'string') {
      throw new Error(`Invalid authority registry entry: ${authorityId || '<empty>'}`)
    }

    validateEd25519SpkiPem(rawEntry.publicKey, authorityId)
    if (rawEntry.revoked !== undefined && typeof rawEntry.revoked !== 'boolean') {
      throw new Error(`Invalid revoked flag for authority: ${authorityId}`)
    }

    entries.push([
      authorityId,
      Object.freeze({
        publicKey: rawEntry.publicKey,
        revoked: rawEntry.revoked ?? false
      })
    ])
  }
  return entries
}

function validateEd25519SpkiPem(publicKey: string, authorityId: string): void {
  if (
    !publicKey.includes('-----BEGIN PUBLIC KEY-----') ||
    !publicKey.includes('-----END PUBLIC KEY-----')
  ) {
    throw new Error(`Authority ${authorityId} publicKey must be an SPKI PEM`)
  }

  try {
    const keyObject = createPublicKey(publicKey)
    if (keyObject.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Authority ${authorityId} publicKey is not Ed25519`)
    }
  } catch (error) {
    throw new Error(
      `Authority ${authorityId} publicKey is not a valid Ed25519 SPKI PEM: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
