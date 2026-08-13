import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

export const AI_DE_RECEIPT_CONTRACT_SOURCE_ENV = 'ORCA_AI_DE_RECEIPT_CONTRACT_SOURCE'

const contractRoot = path.join(__dirname, 'fixtures', 'ai-de-receipt-contract')
const validatorPath = path.join(contractRoot, 'schema-validator.cjs')
const receiptSchemaPath = path.join(contractRoot, 'execution-receipt-1.schema')

type JsonSchemaValidator = {
  validateJsonSchema: (value: unknown, schema: unknown) => boolean
}

export type ReceiptValidationResult = {
  valid: boolean
  output: string
}

export type AiDeReceiptContractComparison =
  | { verified: true }
  | { verified: false; reason: 'source-root-not-configured' | 'source-root-unavailable' }

const requireFromContract = createRequire(validatorPath)
const { validateJsonSchema } = requireFromContract(validatorPath) as JsonSchemaValidator
const receiptSchema = JSON.parse(fs.readFileSync(receiptSchemaPath, 'utf8')) as unknown

function sourceContractPaths(sourceRoot: string) {
  return {
    validator: path.join(
      sourceRoot,
      'harness',
      'runtime',
      'execution-packet',
      'schema-validator.js'
    ),
    schema: path.join(sourceRoot, 'knowledge', 'schemas', 'execution-receipt-1.schema.json')
  }
}

function recordUnavailableComparison(
  reason: 'source-root-not-configured' | 'source-root-unavailable'
) {
  console.warn(
    `[AI-DE receipt contract] source comparison unavailable: env=${AI_DE_RECEIPT_CONTRACT_SOURCE_ENV} reason=${reason}`
  )
}

// Why: a local copy keeps interop tests reproducible; an explicit source root makes contract drift fail visibly.
export function compareAiDeReceiptContract(): AiDeReceiptContractComparison {
  const sourceRoot = process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV]
  if (!sourceRoot) {
    recordUnavailableComparison('source-root-not-configured')
    return { verified: false, reason: 'source-root-not-configured' }
  }

  const sourcePaths = sourceContractPaths(sourceRoot)
  if (!fs.existsSync(sourcePaths.validator) || !fs.existsSync(sourcePaths.schema)) {
    recordUnavailableComparison('source-root-unavailable')
    return { verified: false, reason: 'source-root-unavailable' }
  }

  const mismatchedFiles = [
    ['schema-validator.js', validatorPath, sourcePaths.validator],
    ['execution-receipt-1.schema.json', receiptSchemaPath, sourcePaths.schema]
  ].flatMap(([name, copiedPath, sourcePath]) =>
    fs.readFileSync(copiedPath).equals(fs.readFileSync(sourcePath)) ? [] : [name]
  )

  if (mismatchedFiles.length > 0) {
    throw new Error(
      `[AI-DE receipt contract] source comparison failed: files=${mismatchedFiles.join(',')}`
    )
  }

  return { verified: true }
}

export function validateReceiptWithAiDe(receipt: unknown): ReceiptValidationResult {
  try {
    compareAiDeReceiptContract()
    validateJsonSchema(receipt, receiptSchema)
    return { valid: true, output: '✓ Receipt is valid' }
  } catch (error) {
    return { valid: false, output: error instanceof Error ? error.message : String(error) }
  }
}
