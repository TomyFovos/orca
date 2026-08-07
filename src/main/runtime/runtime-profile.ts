import {
  DEFAULT_ORCA_RUNTIME_PROFILE,
  InvalidOrcaRuntimeProfileError,
  resolveOrcaRuntimeProfile,
  type OrcaRuntimeProfile,
  type RuntimeProfileEnvironment
} from '../../shared/runtime-profile'

export {
  DEFAULT_ORCA_RUNTIME_PROFILE,
  filterOrchestrationSkillDelivery,
  InvalidOrcaRuntimeProfileError,
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  resolveOrcaRuntimeProfile,
  type OrcaRuntimeProfile,
  type RuntimeProfileEnvironment
} from '../../shared/runtime-profile'

let processRuntimeProfile: OrcaRuntimeProfile | undefined

export function resolveOrcaRuntimeProfileAtStartup(
  environment: RuntimeProfileEnvironment,
  failClosed: (error: InvalidOrcaRuntimeProfileError) => never
): OrcaRuntimeProfile {
  try {
    return resolveOrcaRuntimeProfile(environment)
  } catch (error) {
    if (error instanceof InvalidOrcaRuntimeProfileError) {
      return failClosed(error)
    }
    throw error
  }
}

export function setProcessRuntimeProfile(profile: OrcaRuntimeProfile): void {
  processRuntimeProfile = profile
}

export function getProcessRuntimeProfile(): OrcaRuntimeProfile {
  // Why: this default fallback is test-only. Unit tests instantiate lower-level runtime entry
  // points without loading main/index.ts. The production main process always sets this during
  // startup, before PTY, IPC, or RPC initialization.
  return processRuntimeProfile ?? DEFAULT_ORCA_RUNTIME_PROFILE
}
