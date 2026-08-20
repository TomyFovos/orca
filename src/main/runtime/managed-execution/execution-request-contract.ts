export const EXECUTION_REQUEST_CONTRACT_VERSIONS = {
  protocol_version: 'ai-de.protocol/1',
  schema_version: 'execution-request-1'
} as const

type JsonRecord = Record<string, unknown>

type PayloadFieldContract = {
  type?: 'object' | 'string'
  additionalProperties?: false
  required?: readonly string[]
  properties?: Readonly<Record<string, PayloadFieldContract>>
  enum?: readonly string[]
  minLength?: number
  maxLength?: number
  pattern?: string
  sha256?: true
}

type LaunchPlanDigestContract = 'null' | 'sha256' | 'sha256-or-null'

type OperationPayloadContract = {
  launchPlanDigest: LaunchPlanDigestContract
  payload: PayloadFieldContract
}

export type ExecutionOperation = 'prepare' | 'start' | 'stop' | 'cleanup'

export type OperationPayloadContractViolation = Readonly<{
  field: string
  rule: string
}>

export type BindingPayloadEquivalenceViolation = Readonly<{
  field: string
  rule: 'matches-binding'
}>

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'

export const EXECUTION_REQUEST_REQUIRED_PAYLOAD_FIELDS = [
  'schema',
  'operation',
  'request_id',
  'case_id',
  'task_id',
  'attempt_id',
  'packet_digest',
  'protocol_version',
  'schema_version',
  'issued_at',
  'expires_at',
  'operation_payload'
] as const

// The worker executes payload values, while Orca authorizes binding values.
export const EXECUTION_REQUEST_BINDING_PAYLOAD_EQUIVALENCE_FIELDS = [
  'operation',
  'request_id',
  'case_id',
  'task_id',
  'attempt_id',
  'packet_digest',
  'launch_plan_digest',
  'protocol_version',
  'schema_version'
] as const

export const EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT: Readonly<
  Record<ExecutionOperation, OperationPayloadContract>
> = {
  prepare: {
    launchPlanDigest: 'null',
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['adapter'],
      properties: {
        adapter: { enum: ['codex', 'claude', 'copilot', 'opencode'] }
      }
    }
  },
  start: {
    launchPlanDigest: 'sha256',
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['adapter', 'model', 'write_permission', 'prompt'],
      properties: {
        adapter: { enum: ['codex', 'claude', 'copilot', 'opencode'] },
        model: {
          type: 'object',
          additionalProperties: false,
          required: ['adapter', 'concrete_model_id'],
          properties: {
            adapter: { enum: ['codex', 'claude', 'copilot', 'opencode'] },
            concrete_model_id: {
              type: 'string',
              minLength: 1,
              maxLength: 256,
              pattern: '^(?!cloud-|local-coder|local-coder-high|tool-only)'
            },
            provider_id: { type: 'string', minLength: 1, maxLength: 128 }
          }
        },
        write_permission: { enum: ['read-only', 'workspace-write'] },
        prompt: { type: 'string', maxLength: 262_144 },
        prompt_delivery: { enum: ['auto-submit', 'draft'] }
      }
    }
  },
  stop: {
    launchPlanDigest: 'sha256',
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['graceful', 'forced'] },
        reason_code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' }
      }
    }
  },
  cleanup: {
    launchPlanDigest: 'sha256-or-null',
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['verification_digest'],
      properties: {
        verification_digest: { sha256: true }
      }
    }
  }
}

export function findOperationPayloadContractViolation(
  operation: string,
  payload: unknown
): OperationPayloadContractViolation | null {
  if (!isRecord(payload)) {
    return { field: 'request', rule: 'record' }
  }
  for (const requiredField of EXECUTION_REQUEST_REQUIRED_PAYLOAD_FIELDS) {
    if (!(requiredField in payload)) {
      return { field: requiredField, rule: 'required' }
    }
  }
  if (!isExecutionOperation(operation)) {
    return null
  }

  const contract = EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT[operation]
  const launchPlanDigestViolation = findLaunchPlanDigestViolation(
    payload.launch_plan_digest,
    contract.launchPlanDigest
  )
  if (launchPlanDigestViolation) {
    return { field: 'launch_plan_digest', rule: launchPlanDigestViolation }
  }

  return findPayloadFieldViolation(
    payload.operation_payload,
    contract.payload,
    'operation_payload'
  )
}

export function findBindingPayloadEquivalenceViolation(
  binding: Record<string, unknown>,
  payload: Record<string, unknown>
): BindingPayloadEquivalenceViolation | null {
  for (const field of EXECUTION_REQUEST_BINDING_PAYLOAD_EQUIVALENCE_FIELDS) {
    if (binding[field] !== payload[field]) {
      return { field: `/payload/${field}`, rule: 'matches-binding' }
    }
  }
  return null
}

function isExecutionOperation(value: string): value is ExecutionOperation {
  return value in EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT
}

function findLaunchPlanDigestViolation(
  value: unknown,
  contract: LaunchPlanDigestContract
): string | null {
  if (contract === 'null') {
    return value === null ? null : 'null'
  }
  if (value === null) {
    return contract === 'sha256-or-null' ? null : 'sha256'
  }
  return typeof value === 'string' && new RegExp(SHA256_PATTERN).test(value) ? null : 'sha256'
}

function findPayloadFieldViolation(
  value: unknown,
  contract: PayloadFieldContract,
  field: string
): OperationPayloadContractViolation | null {
  if (contract.type === 'object') {
    if (!isRecord(value)) {
      return { field, rule: 'record' }
    }
    for (const requiredField of contract.required ?? []) {
      if (!(requiredField in value)) {
        return { field: `${field}.${requiredField}`, rule: 'required' }
      }
    }
    const properties = contract.properties ?? {}
    if (contract.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return { field: `${field}.${key}`, rule: 'unexpected' }
        }
      }
    }
    for (const [key, propertyContract] of Object.entries(properties)) {
      if (key in value) {
        const violation = findPayloadFieldViolation(value[key], propertyContract, `${field}.${key}`)
        if (violation) {
          return violation
        }
      }
    }
    return null
  }

  if (typeof value !== 'string') {
    return { field, rule: 'string' }
  }
  if (contract.enum && !contract.enum.includes(value)) {
    return { field, rule: 'enum' }
  }
  if (contract.minLength !== undefined && value.length < contract.minLength) {
    return { field, rule: 'min-length' }
  }
  if (contract.maxLength !== undefined && value.length > contract.maxLength) {
    return { field, rule: 'max-length' }
  }
  if (contract.pattern && !new RegExp(contract.pattern).test(value)) {
    return { field, rule: 'pattern' }
  }
  if (contract.sha256 && !new RegExp(SHA256_PATTERN).test(value)) {
    return { field, rule: 'sha256' }
  }
  return null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
