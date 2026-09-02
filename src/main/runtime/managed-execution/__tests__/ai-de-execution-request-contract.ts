import * as fs from 'node:fs'
import * as path from 'node:path'

export const AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV =
  'ORCA_AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE'

const copiedSchemaPath = path.join(
  __dirname,
  'fixtures',
  'ai-de-execution-request-contract',
  'execution-request-1.schema'
)

export type AiDeExecutionRequestContractComparison =
  | { verified: true }
  | { verified: false; reason: 'source-root-not-configured' }

function sourceSchemaPath(sourceRoot: string): string {
  return path.join(sourceRoot, 'knowledge', 'schemas', 'execution-request-1.schema.json')
}

function recordUnavailableComparison(
  reason: 'source-root-not-configured'
): void {
  console.warn(
    `[AI-DE execution request contract] source comparison unavailable: env=${AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV} reason=${reason}`
  )
}

// Why: the copy makes tests reproducible while an explicit AI-DE root keeps contract drift visible.
export function compareAiDeExecutionRequestContract(): AiDeExecutionRequestContractComparison {
  const sourceRoot = process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV]
  if (!sourceRoot) {
    recordUnavailableComparison('source-root-not-configured')
    return { verified: false, reason: 'source-root-not-configured' }
  }

  const sourcePath = sourceSchemaPath(sourceRoot)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      '[AI-DE execution request contract] source comparison failed: reason=source-root-unavailable'
    )
  }

  if (!fs.readFileSync(copiedSchemaPath).equals(fs.readFileSync(sourcePath))) {
    throw new Error(
      '[AI-DE execution request contract] source comparison failed: files=execution-request-1.schema.json'
    )
  }

  return { verified: true }
}

export function readCopiedAiDeExecutionRequestSchema(): unknown {
  return JSON.parse(fs.readFileSync(copiedSchemaPath, 'utf8')) as unknown
}
