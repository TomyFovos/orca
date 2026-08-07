import { ORCHESTRATION_CONTRACT_VERSION } from './protocol-version'

export type OrchestrationMigrationReason =
  | 'client_contract_missing'
  | 'client_contract_unsupported'
  | 'runtime_capability_missing'
  | 'command_retired'

export const ORCHESTRATION_SKILL_COMMAND_ARGS = [
  'skills',
  'get',
  'orchestration',
  '--full'
] as const

export const ORCHESTRATION_LEGACY_RUN_ID = 'run_legacy_local'

const ORCHESTRATION_MUTATION_METHODS = new Set([
  'orchestration.runCreate',
  'orchestration.runUse',
  'orchestration.send',
  'orchestration.reply',
  'orchestration.taskCreate',
  'orchestration.taskUpdate',
  'orchestration.dispatch',
  'orchestration.workerStart',
  'orchestration.workerStop',
  'orchestration.workerAbandon',
  'orchestration.ask',
  'orchestration.gateCreate',
  'orchestration.gateResolve',
  'orchestration.reset',
  'orchestration.federationAttachStart',
  'orchestration.federationAck',
  'orchestration.federationImport',
  'orchestration.federationStop'
])

const RETIRED_ORCHESTRATION_METHODS = new Set(['orchestration.run', 'orchestration.runStop'])

export function isRetiredOrchestrationMethod(method: string): boolean {
  return RETIRED_ORCHESTRATION_METHODS.has(method)
}

export function isOrchestrationMutation(method: string, params: unknown): boolean {
  if (isRetiredOrchestrationMethod(method)) {
    return true
  }
  if (method === 'orchestration.check') {
    if (hasStringProperty(params, 'ack')) {
      return true
    }
    return !isExplicitReadOnlyCheck(params)
  }
  if (method === 'orchestration.dispatch') {
    return !hasTrueProperty(params, 'dryRun')
  }
  return ORCHESTRATION_MUTATION_METHODS.has(method)
}

export type OrchestrationSkillRecoveryData = {
  effectsApplied: false
  guide: { topic: 'orchestration'; full: true }
  nextCommandArgs: typeof ORCHESTRATION_SKILL_COMMAND_ARGS
  nextSteps: string[]
}

export function orchestrationSkillRecoveryData(): OrchestrationSkillRecoveryData {
  return {
    effectsApplied: false,
    guide: { topic: 'orchestration', full: true },
    nextCommandArgs: ORCHESTRATION_SKILL_COMMAND_ARGS,
    nextSteps: [
      'Using this same Orca CLI executable, run: skills get orchestration --full',
      'Read the returned guide completely and do not retry the previous command unchanged.'
    ]
  }
}

export type OrchestrationMigrationData = {
  reason: OrchestrationMigrationReason
  requiredContractVersion: number
  effectsApplied: false
  nextSteps: string[]
  guide?: { topic: 'orchestration'; full: true }
  nextCommandArgs?: typeof ORCHESTRATION_SKILL_COMMAND_ARGS
}

export function orchestrationMigrationData(
  reason: OrchestrationMigrationReason,
  options: { includeSkillRecovery?: boolean } = {}
): OrchestrationMigrationData {
  // Why: a managed runtime must not hand a worker the orchestration skill
  // retrieval command as a recovery action. The caller decides this at the
  // execution boundary; the default preserves legacy callers and CLI output.
  if (options.includeSkillRecovery === false) {
    return {
      reason,
      requiredContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      effectsApplied: false,
      nextSteps: [
        'This managed runtime does not expose orchestration skill recovery.',
        'Contact the external control plane before attempting another orchestration mutation.'
      ]
    }
  }
  return {
    reason,
    requiredContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    ...orchestrationSkillRecoveryData()
  }
}

function isExplicitReadOnlyCheck(params: unknown): boolean {
  return (
    hasTrueProperty(params, 'peek') ||
    hasTrueProperty(params, 'all') ||
    hasFalseProperty(params, 'unread')
  )
}

function hasStringProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[property] === 'string'
  )
}

function hasTrueProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === true
  )
}

function hasFalseProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === false
  )
}
