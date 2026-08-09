# Managed execution authority registry

The managed execution endpoint reads its authority policy once during Orca
startup. Set `ORCA_MANAGED_AUTHORITY_REGISTRY_PATH` to the path of a JSON file
with this shape:

```json
{
  "managed-orca-authority": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "revoked": false
  }
}
```

Each entry is an `authority_id` and an Ed25519 public key in SPKI PEM format.
The `revoked` flag is optional and defaults to `false`. Private keys never
belong in this file.

The file is an authorization policy, not ordinary application data: adding an
entry grants the corresponding private-key holder managed execution authority.
Protect the file and its parent directory from untrusted writes.

Orca validates the file at startup and keeps the parsed registry private and
immutable. A missing, empty, malformed, or non-Ed25519 registry prevents the
managed endpoint from listening. There is no runtime registration or
revocation API; change the file and restart Orca to change policy.

The endpoint binds to `127.0.0.1:6770` by default. Set
`ORCA_MANAGED_ENDPOINT_HOST` and `ORCA_MANAGED_ENDPOINT_PORT` only in the
managed process environment when an explicit bind is required. Port `6768` is
Orca's runtime RPC and `6769` is the development WebSocket/test-fixture port;
the managed default intentionally avoids both.
