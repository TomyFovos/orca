import {
  filterOrchestrationSkillDelivery,
  getProcessRuntimeProfile,
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  type OrcaRuntimeProfile
} from '../runtime-profile'

const managedExecutionAuthorizationBrand = Symbol('managedExecutionAuthorizationBrand')

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
  launch_plan_digest: string | null
  operation: string
  payload_digest: string
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

const issuedAuthorizations = new WeakSet<object>()

type ManagedExecutionAuthorizationRejectionDetail = Readonly<{
  layer: 'authorization'
  operation: string
  field: string
  rule: 'external-control-plane-authorization'
}>

const authorizationRejectionByOperation: Readonly<
  Record<string, ManagedExecutionAuthorizationRejectionDetail>
> = {
  'target CLI startup': {
    layer: 'authorization',
    operation: 'target-cli-startup',
    field: 'target-cli-startup',
    rule: 'external-control-plane-authorization'
  },
  'managed worker startup': {
    layer: 'authorization',
    operation: 'managed-worker-startup',
    field: 'managed-worker-startup',
    rule: 'external-control-plane-authorization'
  },
  'automation worker startup': {
    layer: 'authorization',
    operation: 'automation-worker-startup',
    field: 'automation-worker-startup',
    rule: 'external-control-plane-authorization'
  },
  'Claude Agent Teams startup': {
    layer: 'authorization',
    operation: 'claude-agent-teams',
    field: 'claude-agent-teams',
    rule: 'external-control-plane-authorization'
  },
  'Claude Agent Teams tmux compatibility': {
    layer: 'authorization',
    operation: 'claude-agent-teams',
    field: 'claude-agent-teams',
    rule: 'external-control-plane-authorization'
  },
  'managed worktree removal': {
    layer: 'authorization',
    operation: 'managed-worktree-removal',
    field: 'managed-worktree-removal',
    rule: 'external-control-plane-authorization'
  },
  'orchestration task or dispatch mutation': {
    layer: 'authorization',
    operation: 'task-dispatch-mutation',
    field: 'task-dispatch-mutation',
    rule: 'external-control-plane-authorization'
  },
  'managed Task creation': {
    layer: 'authorization',
    operation: 'task-dispatch-mutation',
    field: 'task-dispatch-mutation',
    rule: 'external-control-plane-authorization'
  },
  'managed Task modification': {
    layer: 'authorization',
    operation: 'task-dispatch-mutation',
    field: 'task-dispatch-mutation',
    rule: 'external-control-plane-authorization'
  },
  'managed Dispatch creation': {
    layer: 'authorization',
    operation: 'task-dispatch-mutation',
    field: 'task-dispatch-mutation',
    rule: 'external-control-plane-authorization'
  }
}

function logManagedExecutionAuthorizationRejection(operation: string): void {
  const detail = authorizationRejectionByOperation[operation] ?? {
    layer: 'authorization' as const,
    operation: 'unrecognized-operation',
    field: 'operation',
    rule: 'external-control-plane-authorization' as const
  }
  // Orca records this boundary rejection because launched agents can bypass their own safeguards.
  console.error(
    `[managed-execution] Request rejected: operation=${detail.operation} layer=${detail.layer} field=${detail.field} rule=${detail.rule}`
  )
}

/**
 * Mint a process-local capability after the envelope issuer has completed all
 * external-control-plane validation. The object is intentionally opaque: only
 * this module can place it in the WeakSet checked by the authorization guard.
 */
export function mintManagedExecutionAuthorization(): ManagedExecutionAuthorization {
  const authorization = {
    [managedExecutionAuthorizationBrand]: true
  } as ManagedExecutionAuthorization
  issuedAuthorizations.add(authorization)
  return authorization
}

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
  logManagedExecutionAuthorizationRejection(operation)
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

/**
 * The orchestration bundle is withheld in managed execution until the external
 * control-plane adapter can authorize its delivery. Keep every other skill in
 * the request so managed skill maintenance does not become a whole-batch deny.
 */
export function filterManagedExecutionSkillDelivery(
  skillNames: readonly string[],
  runtimeProfile: OrcaRuntimeProfile = getProcessRuntimeProfile()
): { allowedNames: string[]; skippedNames: string[] } {
  return filterOrchestrationSkillDelivery(skillNames, runtimeProfile)
}
