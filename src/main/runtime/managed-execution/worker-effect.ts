import { spawnSync } from 'node:child_process'
import os from 'node:os'

export const AI_DE_CLI_PATH_ENV = 'ORCA_AI_DE_CLI_PATH'
export const AI_DE_CLI_FALLBACK_PATH_ENV = 'AIDE_CLI_PATH'

export type WorkerRefusal = Readonly<{
  layer: string
  field: string
  rule: string
  reason_code: string
}>

export type WorkerExecutionResult = Readonly<{
  execution_allowed: boolean
  refusal: WorkerRefusal
  status: string
  spawn_result: unknown
}>

type WorkerOutput = {
  status?: unknown
  execution_allowed?: unknown
  refusal?: unknown
  spawn_result?: unknown
}

type SpawnResult = {
  status: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error
}

type WorkerEffectOptions = Readonly<{
  cliPath?: string
  logger?: (...args: unknown[]) => void
  spawn?: (file: string, args: readonly string[], options: Record<string, unknown>) => SpawnResult
}>

const FALLBACK_REFUSAL: WorkerRefusal = {
  layer: 'trusted-worker-launcher',
  field: 'pipeline',
  rule: 'execution_allowed_true',
  reason_code: 'WORKER_EXECUTION_REFUSED'
}

function refusalFromOutput(value: unknown): WorkerRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return FALLBACK_REFUSAL
  }
  const candidate = value as Record<string, unknown>
  return {
    layer: typeof candidate.layer === 'string' ? candidate.layer : FALLBACK_REFUSAL.layer,
    field: typeof candidate.field === 'string' ? candidate.field : FALLBACK_REFUSAL.field,
    rule: typeof candidate.rule === 'string' ? candidate.rule : FALLBACK_REFUSAL.rule,
    reason_code:
      typeof candidate.reason_code === 'string'
        ? candidate.reason_code
        : FALLBACK_REFUSAL.reason_code
  }
}

function safePathEntries(): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path
  if (!pathValue) {
    return undefined
  }
  const separator = process.platform === 'win32' ? ';' : ':'
  const entries = pathValue
    .split(separator)
    .filter((entry) => entry.length > 0 && !entry.includes('.git'))
  return entries.length > 0 ? entries.join(separator) : undefined
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const pathValue = safePathEntries()
  return pathValue ? { PATH: pathValue } : {}
}

function workerCwd(): string {
  const candidate = os.tmpdir()
  if (!candidate.includes('.git')) {
    return candidate
  }
  return process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp'
}

function defaultSpawn(file: string, args: readonly string[], options: Record<string, unknown>) {
  return spawnSync(file, [...args], options as Parameters<typeof spawnSync>[2]) as SpawnResult
}

function parseWorkerOutput(stdout: string): WorkerOutput | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(lines.at(-1)!)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WorkerOutput)
      : null
  } catch {
    return null
  }
}

export function runManagedWorkerForProtectedEffect(
  payload: Record<string, unknown>,
  options: WorkerEffectOptions = {}
): WorkerExecutionResult {
  const logger = options.logger ?? console.error
  const packetRef = payload.packet_digest
  if (typeof packetRef !== 'string' || packetRef.length === 0) {
    const refusal: WorkerRefusal = {
      layer: 'payload',
      field: 'packet_digest',
      rule: 'required-string',
      reason_code: 'PACKET_REF_MISSING'
    }
    logger('[managed-execution] Protected effect refused:', JSON.stringify(refusal))
    return { execution_allowed: false, refusal, status: 'REJECTED', spawn_result: null }
  }

  const cliPath =
    options.cliPath ??
    process.env[AI_DE_CLI_PATH_ENV] ??
    process.env[AI_DE_CLI_FALLBACK_PATH_ENV] ??
    'aide'
  const spawn = options.spawn ?? defaultSpawn
  let result: SpawnResult
  try {
    result = spawn(cliPath, ['worker', '--packet-ref', packetRef], {
      cwd: workerCwd(),
      env: workerEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024
    })
  } catch (error) {
    const refusal: WorkerRefusal = {
      layer: 'worker-process',
      field: 'executable',
      rule: 'spawn-success',
      reason_code: 'WORKER_SPAWN_FAILED'
    }
    logger(
      '[managed-execution] Protected effect refused:',
      JSON.stringify({ ...refusal, error: error instanceof Error ? error.message : String(error) })
    )
    return { execution_allowed: false, refusal, status: 'REJECTED', spawn_result: null }
  }

  if (result.error) {
    const refusal: WorkerRefusal = {
      layer: 'worker-process',
      field: 'executable',
      rule: 'spawn-success',
      reason_code: 'WORKER_SPAWN_FAILED'
    }
    logger('[managed-execution] Protected effect refused:', JSON.stringify(refusal))
    return { execution_allowed: false, refusal, status: 'REJECTED', spawn_result: null }
  }

  const output = parseWorkerOutput(typeof result.stdout === 'string' ? result.stdout : '')
  const executionAllowed = output?.execution_allowed === true
  if (!executionAllowed) {
    const refusal = refusalFromOutput(output?.refusal)
    logger(
      '[managed-execution] Protected effect refused:',
      JSON.stringify({
        ...refusal,
        status: typeof output?.status === 'string' ? output.status : 'REJECTED',
        exit_status: result.status
      })
    )
    return {
      execution_allowed: false,
      refusal,
      status: typeof output?.status === 'string' ? output.status : 'REJECTED',
      spawn_result: output?.spawn_result ?? null
    }
  }

  return {
    execution_allowed: true,
    refusal: FALLBACK_REFUSAL,
    status: typeof output?.status === 'string' ? output.status : 'SUCCEEDED',
    spawn_result: output?.spawn_result ?? null
  }
}
