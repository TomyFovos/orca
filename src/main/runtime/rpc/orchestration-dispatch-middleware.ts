import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrcaRuntimeProfile } from '../runtime-profile'
import type { RpcContext, RpcRequest } from './core'
import {
  authenticatedCallerFingerprint,
  getOrchestrationMutationExecutor,
  type DurableMutationInvocation,
  type OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'

export type OrchestrationDispatchContext = Pick<
  RpcContext,
  | 'orchestrationCapability'
  | 'authenticatedCallerFingerprint'
  | 'recordMutationReceipt'
  | 'orchestrationMutation'
  | 'legacyCoordinatorRunId'
  | 'legacyCoordinatorAuthority'
  | 'revalidateLegacyCoordinator'
  | 'orchestrationCompatibilityCallerAuthority'
  | 'orchestrationCompatibilityEvidence'
>

export type OrchestrationMethodInvocation = (
  params: unknown,
  context: OrchestrationDispatchContext
) => Promise<unknown> | unknown

export type OrchestrationDispatchMiddleware = {
  invoke(
    request: RpcRequest,
    params: unknown,
    signal: AbortSignal | undefined,
    handler: OrchestrationMethodInvocation
  ): Promise<unknown>
}

class DefaultOrchestrationDispatchMiddleware implements OrchestrationDispatchMiddleware {
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility

  constructor(runtime: OrcaRuntimeService) {
    this.orchestrationMutations = getOrchestrationMutationExecutor(runtime)
    this.legacyOrchestration = new OrchestrationLegacyCompatibility(runtime)
  }

  async invoke(
    request: RpcRequest,
    params: unknown,
    signal: AbortSignal | undefined,
    handler: OrchestrationMethodInvocation
  ): Promise<unknown> {
    const compatibility = await this.legacyOrchestration.tryHandle(request, params, signal)
    if (compatibility.handled) {
      return compatibility.result
    }
    const effectiveParams = compatibility.params ?? params
    const legacyCoordinator = this.legacyOrchestration.createCoordinatorInvocation(
      request,
      compatibility.legacyCoordinatorAuthority
    )
    const invoke = (mutation?: DurableMutationInvocation) => {
      const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
      return handler(effectiveParams, {
        orchestrationCapability: request.orchestrationCapability,
        authenticatedCallerFingerprint:
          mutation?.identity.callerFingerprint ?? authenticatedCallerFingerprint(request),
        recordMutationReceipt: mutation?.recordReceipt,
        orchestrationMutation: mutation?.identity,
        legacyCoordinatorRunId,
        legacyCoordinatorAuthority: legacyCoordinator?.authority,
        revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
        orchestrationCompatibilityCallerAuthority:
          compatibility.orchestrationCompatibilityCallerAuthority,
        orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
      })
    }
    return await this.orchestrationMutations.run(
      request,
      effectiveParams,
      invoke,
      legacyCoordinator?.mutationCallerFingerprint
    )
  }
}

export function createOrchestrationDispatchMiddleware(
  runtime: OrcaRuntimeService,
  profile: OrcaRuntimeProfile
): OrchestrationDispatchMiddleware | undefined {
  if (profile === 'managed') {
    return undefined
  }
  return new DefaultOrchestrationDispatchMiddleware(runtime)
}
