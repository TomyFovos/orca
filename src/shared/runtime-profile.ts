export const DEFAULT_ORCA_RUNTIME_PROFILE = 'default'
export const MANAGED_ORCA_RUNTIME_PROFILE = 'managed'
export const ORCA_RUNTIME_PROFILE_ENV = 'ORCA_RUNTIME_PROFILE'

export type OrcaRuntimeProfile =
  | typeof DEFAULT_ORCA_RUNTIME_PROFILE
  | typeof MANAGED_ORCA_RUNTIME_PROFILE

export type RuntimeProfileEnvironment = Readonly<Record<string, string | undefined>>

export class InvalidOrcaRuntimeProfileError extends Error {
  constructor(configuredProfile: string) {
    super(
      `Unsupported ${ORCA_RUNTIME_PROFILE_ENV} value ${JSON.stringify(configuredProfile)}. ` +
        `Expected ${DEFAULT_ORCA_RUNTIME_PROFILE} or ${MANAGED_ORCA_RUNTIME_PROFILE}.`
    )
    this.name = 'InvalidOrcaRuntimeProfileError'
  }
}

/**
 * Resolves only an absent profile to the legacy-compatible default. A supplied
 * unknown value is rejected so callers cannot silently weaken a managed boundary.
 */
export function resolveOrcaRuntimeProfile(
  environment: RuntimeProfileEnvironment = process.env
): OrcaRuntimeProfile {
  const configuredProfile = environment[ORCA_RUNTIME_PROFILE_ENV]
  if (configuredProfile === undefined) {
    return DEFAULT_ORCA_RUNTIME_PROFILE
  }
  if (configuredProfile === DEFAULT_ORCA_RUNTIME_PROFILE) {
    return DEFAULT_ORCA_RUNTIME_PROFILE
  }
  if (configuredProfile === MANAGED_ORCA_RUNTIME_PROFILE) {
    return MANAGED_ORCA_RUNTIME_PROFILE
  }
  throw new InvalidOrcaRuntimeProfileError(configuredProfile)
}
