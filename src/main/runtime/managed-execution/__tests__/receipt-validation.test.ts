import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EXECUTION_REQUEST_CONTRACT_VERSIONS } from '../execution-request-contract'
import { validateReceiptWithAiDe } from './ai-de-receipt-validator'
const OUTPUT_DIR = path.join(__dirname, 'test-receipts')

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

describe('Orca receipt validation with AI-DE validator', () => {
  it('accepted receipt (outcome=accepted, backend_kind=orca) is valid', async () => {
    const receipt = {
      schema: 'ai-de.execution-receipt/1',
      request_id: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'start',
      case_id: 'case-001',
      task_id: 'task-001',
      attempt_id: 'attempt-001',
      protocol_version: EXECUTION_REQUEST_CONTRACT_VERSIONS.protocol_version,
      // 規範的根拠が未確定のため、現行値を据え置く。
      schema_version: 'execution-envelope-1',
      outcome: 'accepted',
      backend_kind: 'orca',
      backend_ref: 'orca-backend-1',
      backend_session_id: 'session-123',
      accepted_at: new Date().toISOString()
    }

    const receiptPath = path.join(OUTPUT_DIR, 'accepted-orca.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

    const result = validateReceiptWithAiDe(receiptPath)
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
      protocol_version: EXECUTION_REQUEST_CONTRACT_VERSIONS.protocol_version,
      // 規範的根拠が未確定のため、現行値を据え置く。
      schema_version: 'execution-envelope-1',
      outcome: 'replayed',
      backend_kind: 'orca',
      backend_ref: 'orca-backend-1',
      backend_session_id: 'session-123',
      accepted_at: new Date().toISOString()
    }

    const receiptPath = path.join(OUTPUT_DIR, 'replayed-orca.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))

    const result = validateReceiptWithAiDe(receiptPath)
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
      protocol_version: EXECUTION_REQUEST_CONTRACT_VERSIONS.protocol_version,
      // 規範的根拠が未確定のため、現行値を据え置く。
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

    const result = validateReceiptWithAiDe(receiptPath)
    expect(result.valid).toBe(true)
    expect(result.output).toContain('Receipt is valid')
  })
})
