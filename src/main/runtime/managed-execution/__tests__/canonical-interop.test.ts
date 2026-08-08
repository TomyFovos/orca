import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canonicalize, canonicalBytes, CanonicalizationError } from '../canonical'

// 共有テストベクタを読み込み
const vectorsPath = path.join(__dirname, 'fixtures', 'jcs-test-vectors.json')
const vectorsData = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8'))

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

describe('RFC8785-JCS 共有テストベクタ検証', () => {
  it('全ベクタで canonical bytes と sha256 が期待値と一致する', () => {
    for (const vector of vectorsData.vectors) {
      const orcaCanonical = canonicalize(vector.input)
      expect(orcaCanonical).toBe(vector.expected_canonical)

      const orcaBytes = canonicalBytes(vector.input)
      const orcaDigest = sha256(orcaBytes)
      expect(orcaDigest).toBe(`sha256:${vector.expected_sha256}`)
    }
  })

  it('ベクタ1: ASCII のみ・整数のみの envelope', () => {
    const vector = vectorsData.vectors[0]
    expect(canonicalize(vector.input)).toBe(vector.expected_canonical)
    expect(sha256(canonicalBytes(vector.input))).toBe(`sha256:${vector.expected_sha256}`)
  })

  it('ベクタ2: 非 ASCII キー（UTF-8 で 3 バイト）', () => {
    const vector = vectorsData.vectors[1]
    expect(canonicalize(vector.input)).toBe(vector.expected_canonical)
    expect(sha256(canonicalBytes(vector.input))).toBe(`sha256:${vector.expected_sha256}`)
  })

  it('ベクタ3: 負のゼロ（-0）を "0" に正規化', () => {
    const vector = vectorsData.vectors[2]
    const result = canonicalize(vector.input)
    expect(result).toBe(vector.expected_canonical)
    expect(result).toContain('"value":0')
    expect(result).not.toContain('-0')
  })

  it('ベクタ4: ネストされたオブジェクトと配列', () => {
    const vector = vectorsData.vectors[3]
    expect(canonicalize(vector.input)).toBe(vector.expected_canonical)
  })

  it('ベクタ5: エスケープが必要な文字', () => {
    const vector = vectorsData.vectors[4]
    expect(canonicalize(vector.input)).toBe(vector.expected_canonical)
  })

  it('非有限数（Infinity）はエラーをスローする', () => {
    expect(() => canonicalize({ value: Infinity })).toThrow(CanonicalizationError)
    expect(() => canonicalize({ value: Number.NaN })).toThrow(CanonicalizationError)
  })

  it('undefined メンバーはエラーをスローする', () => {
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(CanonicalizationError)
  })
})
