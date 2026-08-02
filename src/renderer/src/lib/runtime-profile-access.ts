import {
  DEFAULT_ORCA_RUNTIME_PROFILE,
  MANAGED_ORCA_RUNTIME_PROFILE,
  type OrcaRuntimeProfile
} from '../../../shared/runtime-profile'

// Why: the profile is fixed at main-process startup before any window exists, so
// it never changes during a renderer session. Cache the first synchronous read
// to avoid a blocking IPC round-trip on every render that consults the profile.
let cachedRuntimeProfile: OrcaRuntimeProfile | null = null

function isValidRuntimeProfile(value: unknown): value is OrcaRuntimeProfile {
  return value === DEFAULT_ORCA_RUNTIME_PROFILE || value === MANAGED_ORCA_RUNTIME_PROFILE
}

/**
 * Reads the fixed startup runtime profile synchronously.
 *
 * Why synchronous: the profile decides whether orchestration surfaces may render
 * at all. An asynchronous read would leave an undetermined window between first
 * paint and IPC resolution during which managed mode could briefly expose UI it
 * must not. The profile is set once before any window is created, so a blocking
 * read is safe (same pattern as `settings:get-sync`).
 *
 * Why fail-closed: when the bridge is missing, throws, or returns an invalid
 * value, the profile resolves to `managed`. Hiding orchestration surfaces in an
 * ambiguous state is safe; exposing them is not. This deliberately never falls
 * back to `default` (the permissive side) on uncertainty.
 */
export function readRuntimeProfileSync(): OrcaRuntimeProfile {
  if (cachedRuntimeProfile !== null) {
    return cachedRuntimeProfile
  }
  let resolved: OrcaRuntimeProfile = MANAGED_ORCA_RUNTIME_PROFILE
  try {
    if (typeof window !== 'undefined') {
      const value = window.api.app.getRuntimeProfileSync()
      if (isValidRuntimeProfile(value)) {
        resolved = value
      }
    }
  } catch {
    resolved = MANAGED_ORCA_RUNTIME_PROFILE
  }
  cachedRuntimeProfile = resolved
  return resolved
}

export function isManagedRuntimeProfile(
  profile: OrcaRuntimeProfile = readRuntimeProfileSync()
): boolean {
  return profile === MANAGED_ORCA_RUNTIME_PROFILE
}

export const _runtimeProfileAccessForTests = {
  /** Clears the cached profile so the next read hits the bridge again. */
  reset(): void {
    cachedRuntimeProfile = null
  },
  /** Forces a cached profile without touching the bridge. */
  set(profile: OrcaRuntimeProfile): void {
    cachedRuntimeProfile = profile
  }
}
