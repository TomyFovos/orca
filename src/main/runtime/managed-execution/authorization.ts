import {
  getProcessRuntimeProfile,
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  type OrcaRuntimeProfile
} from '../runtime-profile'

declare const managedExecutionAuthorizationBrand: unique symbol

/**
 * @provisional
 *
 * The external control plane owns the normative managed-execution protocol and
 * schema. This boundary deliberately accepts only the authority binding fields
 * agreed for the hand-off; it does not interpret task policy, model selection,
 * evidence, retries, or completion.
 */
export type ExternalControlPlaneAuthorityBinding = Readonly<{
  authority_id: string
  request_id: string
  case_id: string
  task_id: string
  attempt_id: string
  packet_digest: string
  launch_plan_digest: string
  protocol_version: string
  schema_version: string
}>

/**
 * @provisional
 *
 * This replaceable adapter is intentionally not registered by Orca yet. The
 * normative protocol owner supplies it after the external contract is settled.
 */
export type ProvisionalManagedExecutionAdapter = Readonly<{
  protocolVersion: string
  schemaVersion: string
  authorizeAuthorityBinding: (
    binding: ExternalControlPlaneAuthorityBinding
  ) => boolean | Promise<boolean>
}>

/**
 * A capability can only be minted by a private main-process issuer. Its WeakSet
 * membership cannot be reconstructed from RPC/IPC data.
 */
export type ManagedExecutionAuthorization = Readonly<{
  [managedExecutionAuthorizationBrand]: true
}>

// No issuer is exported or registered while the normative external contract is
// unsettled. Keeping this set empty makes every protected managed effect reject
// fail-closed. A future adapter must add a module-private issuer here; RPC/IPC
// callers must never receive an issuance API.
const issuedAuthorizations = new WeakSet<object>()

export class ManagedExecutionAuthorizationRequiredError extends Error {
  readonly code = 'managed_execution_authorization_required'

  constructor(operation: string) {
    super(
      `Managed execution cannot perform ${operation} without an external control-plane authorization.`
    )
    this.name = 'ManagedExecutionAuthorizationRequiredError'
  }
}

export function assertManagedExecutionAuthorized(
  operation: string,
  authorization?: unknown
): asserts authorization is ManagedExecutionAuthorization {
  if (getProcessRuntimeProfile() !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return
  }
  if (
    typeof authorization === 'object' &&
    authorization !== null &&
    issuedAuthorizations.has(authorization)
  ) {
    return
  }
  throw new ManagedExecutionAuthorizationRequiredError(operation)
}

/**
 * Propagate the fixed profile to child processes. The managed value overrides
 * caller-supplied environment so a child CLI cannot silently re-enter default.
 */
export function propagateManagedRuntimeProfile<
  T extends Record<string, string | undefined> | undefined
>(environment: T, runtimeProfile: OrcaRuntimeProfile = getProcessRuntimeProfile()): T {
  if (runtimeProfile !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return environment
  }
  return {
    ...environment,
    // Preserve the caller's declared environment shape; the added value is a string.
    [ORCA_RUNTIME_PROFILE_ENV]: MANAGED_ORCA_RUNTIME_PROFILE
  } as unknown as T
}

export function assertManagedExecutionSkillDeliveryAllowed(
  skillNames: readonly string[],
  operation: string,
  runtimeProfile: OrcaRuntimeProfile = getProcessRuntimeProfile()
): void {
  if (runtimeProfile === MANAGED_ORCA_RUNTIME_PROFILE && skillNames.includes('orchestration')) {
    throw new ManagedExecutionAuthorizationRequiredError(operation)
  }
}
