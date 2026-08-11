import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXECUTION_REQUEST_CONTRACT_VERSIONS } from '../execution-request-contract'

function readFixture(name: string): unknown {
  const fixturePath = path.join(__dirname, 'fixtures', name)
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
}

function expectContractVersions(value: Record<string, unknown>): void {
  expect(value.protocol_version === EXECUTION_REQUEST_CONTRACT_VERSIONS.protocol_version).toBe(true)
  expect(value.schema_version === EXECUTION_REQUEST_CONTRACT_VERSIONS.schema_version).toBe(true)
}

describe('managed execution request contract versions', () => {
  it('AI-DE 共有署名ベクタの binding と一致する', () => {
    const fixture = readFixture('execution-envelope-signature-test-vectors.json') as {
      vectors: { envelope: { binding: Record<string, unknown> } }[]
    }

    expectContractVersions(fixture.vectors[0].envelope.binding)
  })

  it('JCS binding ベクタも同じ契約値を使う', () => {
    const fixture = readFixture('jcs-test-vectors.json') as {
      vectors: { input: Record<string, unknown> }[]
    }

    expectContractVersions(fixture.vectors[0].input)
  })
})
