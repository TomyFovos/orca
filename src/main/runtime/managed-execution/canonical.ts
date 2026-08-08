/**
 * RFC8785-JCS (JSON Canonicalization Scheme) 実装
 * AI-DE の harness/runtime/execution-packet/canonical.js と完全に一致する必要がある
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

/**
 * JSON 値を正規化して文字列を返す
 * AI-DE の canonicalize() と完全に一致する実装
 */
export function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError('non-finite number')
    }
    if (Object.is(value, -0)) {
      return '0'
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError('unsupported JSON value')
  }

  // Object.keys().sort() は UTF-16 コード単位順（ASCII ではバイト順と一致）
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined) {
        throw new CanonicalizationError('undefined object member')
      }
      return `${JSON.stringify(key)}:${canonicalize(member)}`
    })

  return `{${entries.join(',')}}`
}

/**
 * JSON 値を正規化して UTF-8 バイト列を返す
 */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8')
}
