export type AuthorityInfo = {
  publicKey: string
  revoked: boolean
}

// 簡易実装: 実際には永続化される
const registry = new Map<string, AuthorityInfo>()

export function getAuthorityRegistry(): Map<string, AuthorityInfo> {
  return registry
}

export function registerAuthority(authority_id: string, info: AuthorityInfo): void {
  registry.set(authority_id, info)
}

export function revokeAuthority(authority_id: string): void {
  const info = registry.get(authority_id)
  if (info) {
    info.revoked = true
  }
}
