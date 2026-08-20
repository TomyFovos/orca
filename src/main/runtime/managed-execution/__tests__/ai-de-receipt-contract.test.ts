import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_DE_RECEIPT_CONTRACT_SOURCE_ENV,
  compareAiDeReceiptContract
} from './ai-de-receipt-contract'

const copiedContractRoot = path.join(__dirname, 'fixtures', 'ai-de-receipt-contract')
const temporaryRoots: string[] = []
const originalSourceRoot = process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV]

function createSourceCopy() {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-ai-de-receipt-contract-'))
  const validatorDir = path.join(sourceRoot, 'harness', 'runtime', 'execution-packet')
  const schemaDir = path.join(sourceRoot, 'knowledge', 'schemas')
  fs.mkdirSync(validatorDir, { recursive: true })
  fs.mkdirSync(schemaDir, { recursive: true })
  fs.copyFileSync(
    path.join(copiedContractRoot, 'schema-validator.cjs'),
    path.join(validatorDir, 'schema-validator.js')
  )
  fs.copyFileSync(
    path.join(copiedContractRoot, 'execution-receipt-1.schema'),
    path.join(schemaDir, 'execution-receipt-1.schema.json')
  )
  temporaryRoots.push(sourceRoot)
  return sourceRoot
}

afterEach(() => {
  if (originalSourceRoot === undefined) {
    delete process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV]
  } else {
    process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV] = originalSourceRoot
  }

  for (const root of temporaryRoots.splice(0)) {
    const validator = path.join(
      root,
      'harness',
      'runtime',
      'execution-packet',
      'schema-validator.js'
    )
    const schema = path.join(root, 'knowledge', 'schemas', 'execution-receipt-1.schema.json')
    fs.rmSync(validator)
    fs.rmSync(schema)
    fs.rmdirSync(path.dirname(validator))
    fs.rmdirSync(path.dirname(path.dirname(validator)))
    fs.rmdirSync(path.dirname(path.dirname(path.dirname(validator))))
    fs.rmdirSync(path.dirname(schema))
    fs.rmdirSync(path.dirname(path.dirname(schema)))
    fs.rmdirSync(root)
  }
})

describe('AI-DE receipt contract copy', () => {
  it('records an unavailable source comparison without bypassing the copied contract', () => {
    delete process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV]
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(compareAiDeReceiptContract()).toEqual({
      verified: false,
      reason: 'source-root-not-configured'
    })
    expect(warning).toHaveBeenCalledWith(
      `[AI-DE receipt contract] source comparison unavailable: env=${AI_DE_RECEIPT_CONTRACT_SOURCE_ENV} reason=source-root-not-configured`
    )
    warning.mockRestore()
  })

  it('accepts a byte-identical explicitly configured source copy', () => {
    process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV] = createSourceCopy()

    expect(compareAiDeReceiptContract()).toEqual({ verified: true })
  })

  it('rejects an explicitly configured source copy that drifts from the checked-in contract', () => {
    const sourceRoot = createSourceCopy()
    process.env[AI_DE_RECEIPT_CONTRACT_SOURCE_ENV] = sourceRoot
    const sourceSchema = path.join(
      sourceRoot,
      'knowledge',
      'schemas',
      'execution-receipt-1.schema.json'
    )
    fs.appendFileSync(sourceSchema, '\n')

    expect(() => compareAiDeReceiptContract()).toThrow(
      '[AI-DE receipt contract] source comparison failed: files=execution-receipt-1.schema.json'
    )
    console.log(
      '[AI-DE receipt contract negative control] drift rejected: files=execution-receipt-1.schema.json'
    )
  })
})
