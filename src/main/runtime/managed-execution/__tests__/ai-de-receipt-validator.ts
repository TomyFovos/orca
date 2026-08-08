import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

const AI_DE_PATH = '/home/atsou/src/github.com/TomyFovos/AI-DE'
const VALIDATOR_MODULE = path.join(
  AI_DE_PATH,
  'harness/runtime/execution-packet/schema-validator.js'
)
const RECEIPT_SCHEMA_PATH = path.join(
  AI_DE_PATH,
  'knowledge/schemas/execution-receipt-1.schema.json'
)

type JsonSchemaValidator = {
  validateJsonSchema: (value: unknown, schema: unknown) => boolean
}

const requireFromAiDe = createRequire(VALIDATOR_MODULE)
const { validateJsonSchema } = requireFromAiDe(VALIDATOR_MODULE) as JsonSchemaValidator
const receiptSchema = JSON.parse(fs.readFileSync(RECEIPT_SCHEMA_PATH, 'utf8')) as unknown

export type ReceiptValidationResult = {
  valid: boolean
  output: string
}

export function validateReceiptWithAiDe(receiptPath: string): ReceiptValidationResult {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as unknown
    validateJsonSchema(receipt, receiptSchema)
    return { valid: true, output: '✓ Receipt is valid' }
  } catch (error) {
    return { valid: false, output: error instanceof Error ? error.message : String(error) }
  }
}
