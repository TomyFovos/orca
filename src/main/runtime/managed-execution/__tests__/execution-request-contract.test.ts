import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXECUTION_REQUEST_CONTRACT_VERSIONS } from '../execution-request-contract'

type ContractVersions = typeof EXECUTION_REQUEST_CONTRACT_VERSIONS

function readFixture(name: string): unknown {
  const fixturePath = path.join(__dirname, 'fixtures', name)
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
}

function contractVersions(value: Record<string, unknown>): ContractVersions {
  return {
    protocol_version: value.protocol_version as ContractVersions['protocol_version'],
    schema_version: value.schema_version as ContractVersions['schema_version']
  }
}

describe('managed execution request contract versions', () => {
  it('AI-DE 共有署名ベクタの binding と一致する', () => {
    const fixture = readFixture('execution-envelope-signature-test-vectors.json') as {
      vectors: Array<{ envelope: { binding: Record<string, unknown> } }>
    }

    expect(contractVersions(fixture.vectors[0].envelope.binding)).toEqual(
      EXECUTION_REQUEST_CONTRACT_VERSIONS
    )
  })

  it('JCS binding ベクタも同じ契約値を使う', () => {
    const fixture = readFixture('jcs-test-vectors.json') as {
      vectors: Array<{ input: Record<string, unknown> }>
    }

    expect(contractVersions(fixture.vectors[0].input)).toEqual(EXECUTION_REQUEST_CONTRACT_VERSIONS)
  })
})
