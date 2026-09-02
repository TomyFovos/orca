import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV,
  compareAiDeExecutionRequestContract
} from './ai-de-execution-request-contract'

const copiedSchemaPath = path.join(
  __dirname,
  'fixtures',
  'ai-de-execution-request-contract',
  'execution-request-1.schema'
)
const temporaryRoots: string[] = []
const originalSourceRoot = process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV]

function createSourceCopy(): string {
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orca-ai-de-execution-request-contract-')
  )
  const schemaDir = path.join(sourceRoot, 'knowledge', 'schemas')
  fs.mkdirSync(schemaDir, { recursive: true })
  fs.copyFileSync(copiedSchemaPath, path.join(schemaDir, 'execution-request-1.schema.json'))
  temporaryRoots.push(sourceRoot)
  return sourceRoot
}

afterEach(() => {
  vi.restoreAllMocks()

  if (originalSourceRoot === undefined) {
    delete process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV]
  } else {
    process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV] = originalSourceRoot
  }

  for (const root of temporaryRoots.splice(0)) {
    const schemaPath = path.join(root, 'knowledge', 'schemas', 'execution-request-1.schema.json')
    if (fs.existsSync(schemaPath)) {
      fs.rmSync(schemaPath)
    }
    if (fs.existsSync(path.dirname(schemaPath))) {
      fs.rmdirSync(path.dirname(schemaPath))
    }
    if (fs.existsSync(path.dirname(path.dirname(schemaPath)))) {
      fs.rmdirSync(path.dirname(path.dirname(schemaPath)))
    }
    fs.rmdirSync(root)
  }
})

describe('AI-DE execution request contract copy', () => {
  it('records an unavailable source comparison without bypassing the copied contract', () => {
    delete process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV]
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(compareAiDeExecutionRequestContract()).toEqual({
      verified: false,
      reason: 'source-root-not-configured'
    })
    expect(warning).toHaveBeenCalledWith(
      `[AI-DE execution request contract] source comparison unavailable: env=${AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV} reason=source-root-not-configured`
    )
  })

  it('rejects an unavailable explicitly configured source', () => {
    const sourceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'orca-ai-de-execution-request-contract-missing-')
    )
    temporaryRoots.push(sourceRoot)
    process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV] = sourceRoot
    expect(() => compareAiDeExecutionRequestContract()).toThrow(
      '[AI-DE execution request contract] source comparison failed: reason=source-root-unavailable'
    )
  })

  it('accepts a byte-identical explicitly configured AI-DE source copy', () => {
    process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV] = createSourceCopy()

    expect(compareAiDeExecutionRequestContract()).toEqual({ verified: true })
  })

  it('rejects an explicitly configured AI-DE source copy that drifts', () => {
    const sourceRoot = createSourceCopy()
    process.env[AI_DE_EXECUTION_REQUEST_CONTRACT_SOURCE_ENV] = sourceRoot
    fs.appendFileSync(
      path.join(sourceRoot, 'knowledge', 'schemas', 'execution-request-1.schema.json'),
      '\n'
    )

    expect(() => compareAiDeExecutionRequestContract()).toThrow(
      '[AI-DE execution request contract] source comparison failed: files=execution-request-1.schema.json'
    )
  })
})
