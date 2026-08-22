import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXECUTION_REQUEST_CONTRACT_VERSIONS,
  EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT,
  EXECUTION_REQUEST_REQUIRED_PAYLOAD_FIELDS,
  type ExecutionOperation
} from '../execution-request-contract'

const AI_DE_EXECUTION_REQUEST_SCHEMA =
  '/home/atsou/src/github.com/TomyFovos/AI-DE/knowledge/schemas/execution-request-1.schema.json'

type JsonRecord = Record<string, unknown>

function readFixture(name: string): unknown {
  const fixturePath = path.join(__dirname, 'fixtures', name)
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
}

function expectContractVersions(value: Record<string, unknown>): void {
  // Compare booleans to keep fixture values out of assertion failure output.
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

  it('operation payload contract matches the AI-DE execution request schema', () => {
    const schema = JSON.parse(fs.readFileSync(AI_DE_EXECUTION_REQUEST_SCHEMA, 'utf8')) as JsonRecord
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : []
    expect(variants.length).toBeGreaterThan(0)

    for (const [operation, contract] of Object.entries(
      EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT
    ) as [
      ExecutionOperation,
      (typeof EXECUTION_REQUEST_OPERATION_PAYLOAD_CONTRACT)[ExecutionOperation]
    ][]) {
      const variant = variants.find(
        (candidate) =>
          isRecord(candidate) &&
          isRecord(candidate.properties) &&
          isRecord(candidate.properties.operation) &&
          candidate.properties.operation.const === operation
      )
      expect(isRecord(variant) && isRecord(variant.properties)).toBe(true)
      const properties = (variant as { properties: JsonRecord }).properties
      expect(
        matchesLaunchPlanDigest(properties.launch_plan_digest, contract.launchPlanDigest)
      ).toBe(true)
      expect(matchesPayloadContract(properties.operation_payload, contract.payload)).toBe(true)
    }
  })

  it('request root required fields match the AI-DE execution request schema', () => {
    const schema = JSON.parse(fs.readFileSync(AI_DE_EXECUTION_REQUEST_SCHEMA, 'utf8')) as JsonRecord
    expect(sameStringArray(schema.required, EXECUTION_REQUEST_REQUIRED_PAYLOAD_FIELDS)).toBe(true)
  })
})

function matchesLaunchPlanDigest(value: unknown, contract: string): boolean {
  if (!isRecord(value)) {
    return false
  }
  if (contract === 'null') {
    return value.const === null
  }
  if (contract === 'sha256') {
    return value.$ref === '#/$defs/sha256'
  }
  return (
    Array.isArray(value.oneOf) &&
    value.oneOf.some((candidate) => isRecord(candidate) && candidate.$ref === '#/$defs/sha256') &&
    value.oneOf.some((candidate) => isRecord(candidate) && candidate.type === 'null')
  )
}

function matchesPayloadContract(value: unknown, contract: unknown): boolean {
  if (!isRecord(value) || !isRecord(contract)) {
    return false
  }
  if (
    value.type !== contract.type ||
    value.additionalProperties !== contract.additionalProperties
  ) {
    return false
  }
  if (contract.type !== 'object') {
    return (
      sameOptionalStringArray(value.enum, contract.enum) &&
      value.minLength === contract.minLength &&
      value.maxLength === contract.maxLength &&
      value.pattern === contract.pattern &&
      (contract.sha256 !== true || value.$ref === '#/$defs/sha256')
    )
  }
  if (!sameStringArray(value.required, contract.required)) {
    return false
  }
  const schemaProperties = value.properties
  const contractProperties = contract.properties
  if (!isRecord(schemaProperties) || !isRecord(contractProperties)) {
    return false
  }
  const schemaFields = Object.keys(schemaProperties).sort()
  const contractFields = Object.keys(contractProperties).sort()
  if (!sameStringArray(schemaFields, contractFields)) {
    return false
  }
  return schemaFields.every((field) =>
    matchesPayloadContract(schemaProperties[field], contractProperties[field])
  )
}

function sameStringArray(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }
  return left.every((value, index) => value === right[index])
}

function sameOptionalStringArray(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return sameStringArray(left, right)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
