import { randomUUID } from 'node:crypto'
import { IssuerError, IssuerErrorCode } from './issuer'

export const DEFAULT_ATTEMPT_IDENTITY_CAPACITY = 1024

export type AttemptIdentity = Readonly<{
  attemptId: string
  backendRef: string
  backendSessionId: string
}>

export type AttemptIdentityResolution = Readonly<{
  identity: AttemptIdentity
  isNew: boolean
}>

// Why: AI-DE rejects any backend identity change after an attempt's first receipt.
export class AttemptIdentityRegistry {
  private readonly identities = new Map<string, AttemptIdentity>()

  constructor(private readonly capacity: number = DEFAULT_ATTEMPT_IDENTITY_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('attempt identity capacity must be a positive integer')
    }
  }

  get size(): number {
    return this.identities.size
  }

  get isAtCapacity(): boolean {
    return this.identities.size >= this.capacity
  }

  get(attemptId: string): AttemptIdentity | undefined {
    return this.identities.get(attemptId)
  }

  has(attemptId: string): boolean {
    return this.identities.has(attemptId)
  }

  // Why: prepare establishes the binding; later verbs must replay it for AI-DE's check.
  resolve(attemptId: string, operation: string): AttemptIdentityResolution {
    const existing = this.identities.get(attemptId)
    if (existing) {
      return { identity: existing, isNew: false }
    }
    if (operation !== 'prepare') {
      throw new IssuerError(IssuerErrorCode.UNKNOWN_ATTEMPT, 'attempt_id is not registered', {
        layer: 'attempt-registry',
        field: 'attempt_id',
        rule: 'registered-attempt'
      })
    }
    if (this.isAtCapacity) {
      throw new IssuerError(
        IssuerErrorCode.ATTEMPT_REGISTRY_CAPACITY_EXCEEDED,
        'Managed execution attempt registry capacity reached',
        { layer: 'attempt-registry', field: 'accepted_attempts', rule: 'max-entries' }
      )
    }
    return {
      identity: {
        attemptId,
        backendRef: `orca-attempt-${randomUUID()}`,
        backendSessionId: `orca-session-${randomUUID()}`
      },
      isNew: true
    }
  }

  // Why: eviction would silently rotate an identity that AI-DE requires to remain stable.
  register(identity: AttemptIdentity): boolean {
    const existing = this.identities.get(identity.attemptId)
    if (existing) {
      return false
    }
    if (this.isAtCapacity) {
      return false
    }
    this.identities.set(identity.attemptId, identity)
    return true
  }

  commit(resolution: AttemptIdentityResolution): void {
    if (resolution.isNew && !this.register(resolution.identity)) {
      throw new Error('attempt identity changed before commit')
    }
  }
}
