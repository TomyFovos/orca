import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const AI_DE_PATH = '/home/atsou/src/github.com/TomyFovos/AI-DE'
const VALIDATOR_SCRIPT = path.join(AI_DE_PATH, 'harness/scripts/validate-receipt.js')
const OUTPUT_DIR = path.join(__dirname, 'test-receipts')

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

describe('Orca receipt validation with AI-DE validator', () => {
  async function validateReceipt(receiptPath: string): Promise<{ valid: boolean; output: string }> {
    return new Promise((resolve) => {
      const proc = spawn('node', [VALIDATOR_SCRIPT, receiptPath])
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data
      })
      proc.stderr.on('data', (data) => {
        stderr += data
      })

      proc.on('close', (code) => {
        resolve({
          valid: code === 0,
          output: code === 0 ? stdout.trim() : stderr.trim()
        })
      })
    })
  }

  it('accepted receipt (outcome=accepted, backend_kind=orca) is valid', async () => {
    const receipt = {
      schema: 'ai-de.execution-receipt/1',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'start',
      case_id: 'case-001',
      task_id: 'task-001',
      attempt_id: 'attempt-001',
      protocol_version: 'ai-de-trusted-launcher/1',
      schema_version: 'execution-envelope-1',
      outcome: 'accepted',
      backend_kind: 'orca',
      backend_ref: 'orca-backend-1',
      backend_session_id: 'session-123',
      accepted_at: new Date().toISOString()
    }

    const receiptPath = path.join(OUTPUT_DIR, 'accepted-orca.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

    const result = await validateReceipt(receiptPath)
    expect(result.valid).toBe(true)
    expect(result.output).toContain('Receipt is valid')
  })

  it('replayed receipt (outcome=replayed, backend_kind=orca) is valid', async () => {
    const receipt = {
      schema: 'ai-de.execution-receipt/1',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'start',
      case_id: 'case-001',
      task_id: 'task-001',
      attempt_id: 'attempt-001',
      protocol_version: 'ai-de-trusted-launcher/1',
      schema_version: 'execution-envelope-1',
      outcome: 'replayed',
      backend_kind: 'orca',
      backend_ref: 'orca-backend-1',
      backend_session_id: 'session-123',
      accepted_at: new Date().toISOString()
    }

    const receiptPath = path.join(OUTPUT_DIR, 'replayed-orca.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

    const result = await validateReceipt(receiptPath)
    expect(result.valid).toBe(true)
    expect(result.output).toContain('Receipt is valid')
  })

  it('rejected receipt (outcome=rejected, backend_kind=orca) is valid', async () => {
    const receipt = {
      schema: 'ai-de.execution-receipt/1',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'start',
      case_id: 'case-001',
      task_id: 'task-001',
      attempt_id: 'attempt-001',
      protocol_version: 'ai-de-trusted-launcher/1',
      schema_version: 'execution-envelope-1',
      outcome: 'rejected',
      reject_reason: 'INVALID_SIGNATURE',
      backend_kind: 'orca',
      backend_ref: null,
      backend_session_id: null,
      accepted_at: new Date().toISOString()
    }

    const receiptPath = path.join(OUTPUT_DIR, 'rejected-orca.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

    const result = await validateReceipt(receiptPath)
    expect(result.valid).toBe(true)
    expect(result.output).toContain('Receipt is valid')
  })
})
