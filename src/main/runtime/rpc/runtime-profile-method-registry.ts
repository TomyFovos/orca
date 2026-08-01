import type { OrcaRuntimeProfile } from '../runtime-profile'
import type { RpcAnyMethod } from './core'

const MANAGED_RUNTIME_EXCLUDED_METHOD_PREFIXES = ['orchestration.', 'agentTeams.'] as const

export function selectRpcMethodsForRuntimeProfile(
  profile: OrcaRuntimeProfile,
  methods: readonly RpcAnyMethod[]
): readonly RpcAnyMethod[] {
  if (profile === 'default') {
    return methods
  }
  // Why: the legacy coordinator namespace mixes decisions with state. Until a generic
  // managed-execution adapter defines its allowed state contract, fail closed rather
  // than exposing a coordinator entry point by accident.
  return methods.filter(
    (method) =>
      !MANAGED_RUNTIME_EXCLUDED_METHOD_PREFIXES.some((prefix) => method.name.startsWith(prefix))
  )
}
