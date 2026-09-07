# AI-DE Protocol Client — Basic Design Candidate (Orca #64)

Status: candidate. Human requirements/design confirmation and `/approve-design` are still pending;
no production implementation may start from this document. S1–S5 are dependency order after that
gate, not implementation authorization and not a v0.1/v0.2 wire-spec split.

See also: [category index](README.md) · [requirements](requirements.md) · [open contract points](open-contract-points.md)

## 1. Design Freeze and invariants

1. AI-DE State Store is the runtime State SSOT. Orca is **Projection + Command only**.
2. Main process owns the validated, replaceable client projection. The renderer receives a
   replace-only UI replica; neither is an authority over State Store.
3. Every authoritative value entering Orca passes the generated #184 validator and provenance
   check first. `catalog_id`, `schema_identity`, method/entity/error registries, feature bindings,
   schemas, error enums, fixtures, and vectors are never hand-copied or replaced by local constants.
4. Event is notification/invalidation only. Event payloads never mutate or become SSOT.
5. Orca does not own policy decisions, provider/model routing, plan generation, completion, gate
   authority, or semantic retry/fallback policy.
6. An unresolved contract is represented by an explicit seam and status in
   [open contract points](open-contract-points.md), never by an Orca default or placeholder DTO.
7. A projection may become `CURRENT` only after the #186 ordering/convergence contract has been
   applied atomically. Generation identity alone cannot establish freshness.

## 2. Module decomposition (proposed, under `src/main/ai-de-protocol/`)

| Module | Responsibility | Explicitly not responsible for | Required owner/artifact |
| --- | --- | --- | --- |
| Endpoint/principal validator | Check endpoint provenance, canonical path, file type, owner/perms, peer identity, and TOCTOU-safe connect | Choosing permissive discovery or principal defaults | #185 endpoint artifact (`OCP-ENDPOINT`) |
| NDJSON codec | UTF-8 decode, line framing, split-frame assembly, injected limits, refusal classification | Business meaning, locally chosen limits | #185 framing artifact (`OCP-FRAME`) |
| Connection lifecycle controller | Bound reconnect/backoff, generation allocation/retirement, transport-only recovery, stop-before-session behavior | Session negotiation, semantic retry, authority decisions | #185 connection/backoff artifact (`OCP-CONNECTION`) |
| JSON-RPC session | Request correlation, response/notification demux, envelope/ID validation | Method semantics, authorization | #184 generated JSON-RPC schema |
| Contract artifact adapter | Import generated #184 schema/validator/registry, verify manifest/provenance/drift | Defining or copying schemas | #184 export/manifest (`OCP-DIST`) |
| Negotiation controller | `initialize`, version/feature selection, refusal on mismatch/unnegotiated use | Capability authorization or fallback ladder | #184 generated initialize/feature registry (`OCP-NEGOTIATION`) |
| Discovery adapter/controller | Consume generated Project list and project-scoped WorkItem query, opaque continuation, order/revision metadata, and visibility/auth result | Project registry, ordering policy, authorization, cache inference, or event-state mutation | #209 decision + #184 generated registry + #186 invalidation (`OCP-DISCOVERY`) |
| Connection generation controller | Connect, generation identity, retire, bounded transport backoff, reconnect sequencing | Effectful command retry or semantic fallback | #185 disconnect/backoff contract |
| Convergence controller | Subscribe/snapshot lifecycle, stale/current state, contract-defined order comparison, refresh scheduling | Merging event fields or selecting a race algorithm | #186 algorithm/fixtures (`OCP-RACE`) |
| Projection owner/publisher | Atomically replace validated projection; tag generation + revision/order identity; publish immutable IPC update | Becoming State SSOT or incrementing revisions | #184/#186 snapshot contract, #189 revision authority |
| Command dispatcher | Build generated command, attach stable ID/seen revision, classify owner-defined outcome | Choosing retry/duplicate semantics, changing projection, gate decision | #187 matrix, #193 receipt contract (`OCP-COMMAND`, `OCP-RECEIPT`) |
| Error/refusal mapper | Map generated errors to stable local classes; preserve safe code/data; record refusal reason | Inventing protocol codes or exposing raw diagnostics | #184 error artifact, #185 redaction (`OCP-DIAGNOSTICS`) |
| Preload authorization boundary | Allow-listed typed snapshot/subscription/command/status calls for approved contexts/profile | Generic method passthrough or gate override | Orca #2 + #202 context contract (`OCP-IPC-CALLER`) |

Existing code references are patterns only and are not wire-compatible:

- Inbound NDJSON hardening: `src/main/runtime/rpc/unix-socket-transport.ts:11`
- JSONL correlation/lifecycle: `src/main/codex/codex-app-server-session.ts:98`
- Subscription/generation/backoff patterns: `src/renderer/src/runtime/runtime-client-events.ts:14`
  and `src/renderer/src/hooks/runtime-client-events-sync.ts:49`
- Renderer call boundary: `src/renderer/src/runtime/runtime-rpc-client.ts:42`
- Main/preload/renderer boundary: `src/main/ipc/runtime.ts:48`, `src/preload/index.ts:4226`,
  `src/preload/api-types.ts:3291`
- Store composition points for a UI replica (not authority): `src/renderer/src/store/index.ts:52`,
  `src/renderer/src/store/types.ts:42`

## 3. Endpoint, transport, and session boundary

The endpoint/principal decision is owned by #185. The transport controller is also #185-owned: it
decides when a connection may be established, how long a generation may live, and how bounded
reconnect/backoff behaves before any JSON-RPC session starts. The client-side design requires the
following fail-closed checks once that artifact is available:

1. Resolve only the contract-approved endpoint provenance and canonical path. Reject symlinks,
   directories, regular files, and sockets with unexpected owner/group/mode.
2. Obtain peer credentials where the platform supports them and compare them with the approved
   principal. An unavailable credential is not silently treated as trusted.
3. Avoid check-then-use TOCTOU: connect/open through the contract-safe primitive and revalidate
   identity after connect where required. If the endpoint is replaced between validation and connect,
   retire the attempt and record `AI_DE_PROTOCOL_ENDPOINT_UNTRUSTED`.
4. Apply the same principal and diagnostic rules to the configured SSH/remote mode; remote mode is
   not a second protocol or a separate approval path.

Exact path roots, permission values, peer fields, platform exceptions, and remote forwarding belong
in the #185 artifact. Until its status is `AVAILABLE`, the validator exposes a seam and does not
connect with a locally relaxed rule. Transport-only recovery may run up to the point of generation
retirement, but JSON-RPC session start remains blocked until the #184 schema distribution is
available and validated.

## 4. Connection lifecycle and generations

```
validate endpoint/principal (#185)
  -> connect UDS (or approved remote mode)
  -> allocate generation G
  -> transport-only recovery/backoff (#185)
  -> if transport contract is unavailable: retire G and stop
  -> if #184 distribution is unavailable: stay transport-only and do not start JSON-RPC session
  -> initialize (generated version range + offered features)
  -> mismatch/refusal: record reason, retire G, stop
  -> negotiate selected version/features
  -> subscribe (contract identity)
  -> acquire full authoritative snapshot
  -> apply #186 convergence/order algorithm
  -> atomically publish CURRENT projection for G
```

An optional Project list or project-scoped WorkItem discovery query may run only after negotiation
when the generated #184 identity/feature binding and #209 discovery contract are `AVAILABLE`. Its
ordering relative to subscription/snapshot is owner-defined; if unavailable, Orca refuses the
request without a local registry.

The projection states are `DISCONNECTED`, `ACQUIRING`, `CURRENT`, and `STALE`; only the convergence
controller may make the `ACQUIRING -> CURRENT` transition. An event or uncertain ordering keeps the
state `STALE` until the owner algorithm completes.

Disconnect retires G, marks the main projection and renderer replica stale, and drops late frames
from G. In-flight requests are classified by the #187 request-class/disconnect-point matrix; they
are not all given the same unknown-effect outcome. A reconnect allocates G+1 and repeats initialize,
subscribe, snapshot, and convergence before currentness. Backoff is bounded transport behavior from
#185, not semantic command retry.

## 5. Snapshot/event convergence and ordering

### 5.1 Projection invariants

- A validated snapshot replaces the complete main-process projection atomically; no field merge or
  local state-machine transition is permitted.
- Every candidate update carries `(generation, revision/order identity)` supplied by #184/#186. An
  update from a retired generation is rejected. An older update in the same generation cannot replace
  a newer one. If identities are incomparable or absent, the result is recorded as stale/refused.
- Main-to-renderer updates carry the same identity. Renderer accepts only a newer update under the
  contract relation and replaces its entire UI replica; it never merges or increments identity.

### 5.2 Owner-controlled race algorithm

The subscribe/snapshot race and event ordering algorithm is **not selected in Orca**. #186 must publish
one normative algorithm and fixtures. Candidate forms (not defaults) include:

- compare a snapshot watermark/revision with event order and discard older events;
- serialize/coalesce refreshes and commit responses in owner order; or
- use a request epoch plus queued-dirty bit so an event during snapshot causes another refresh.

The artifact must define the comparison relation, handling of events during initial snapshot, atomic
transition to `CURRENT`, and out-of-order response behavior. Until it is `AVAILABLE`, the convergence
controller has no strategy implementation and remains stale. In particular, “subscribe then one
successful snapshot” is not enough to claim currentness.

### 5.3 Project and WorkItem discovery (D209)

Discovery is a contract-defined query, not a local Project registry. The exact method and entity
identifiers are admitted from the generated #184 catalog only after its manifest is verified and
#209 is `AVAILABLE`. The owner artifact must define both the Project list and the project-scoped
WorkItem query, including:

- deterministic/stable ordering and an opaque continuation token (Orca stores but does not parse it);
- revision or consistency metadata that can be compared using the published relation;
- principal-scoped visibility and authorization, including the structured refusal category;
- bounded result/page behavior and the invalid-continuation response; and
- #186 event cursor/gap/invalidation behavior, which schedules an authoritative resnapshot/query
  rather than mutating a result locally.

Until those artifacts and fixtures are published as `AVAILABLE`, no discovery request is emitted,
no project is inferred from git, worktrees, terminal/SSH state, or cache, and no UI may claim a
project is discoverable. Missing identity/feature, unauthorized visibility, invalid continuation,
or incomparable revision fails closed with a bounded reason. Discovery results are replace-only
projection data; Orca does not become State Store, policy, or gate authority.

The design targets are `DISC-P01` (authorized Project list), `DISC-P02` (project-scoped WorkItem
query with order/continuation/revision), `DISC-N01` (invalid continuation), `DISC-N02` (visibility /
authorization refusal), `DISC-N03` (revision or invalidation gap forces resnapshot), and `DISC-N04`
(unknown generated method/feature or identity). These are traceability labels, not a hand-written
wire schema.

Required owner fixtures include:

- `ORD-N01`: an older refresh response arriving after a newer response cannot roll the projection back;
- `ORD-N02`: an event during initial snapshot is not lost and currentness is atomic;
- `ORD-P01`: monotonic replacement with same-generation order identity;
- `EVT-N02`: a late frame from a retired generation cannot alter main or renderer state.

## 6. Command path and ambiguity matrix

```
user intent + displayed snapshot revision
  -> generated command + stable command_id
  -> owner-approved send/retry policy
  -> authoritative receipt / conflict / denial
  -> refresh or stale/conflict presentation (never optimistic mutation)
```

The command ID remains stable for a logical intent only when #187 permits a retry. The dispatcher
does not automatically retry while `OCP-COMMAND` is unavailable. `expected_revision` is copied from
the snapshot the user saw; Orca never increments it. A duplicate is interpreted only according to
the owner-defined receipt/marker shape.

### 6.1 Required #187 outcome matrix (not yet a local decision)

| Request class / disconnect point | Required owner outcome | Orca interim posture |
| --- | --- | --- |
| `initialize` before host response | Deterministic re-connect/re-initialize behavior | Retire generation; no same-ID semantic retry. |
| Read-only snapshot/query before request write | Whether safe automatic retry is allowed and bound | Classify transport result as unresolved until #187/#185 artifact; remain stale. |
| Read-only query after write, before response | Whether duplicate query is harmless and how result is surfaced | Do not assume effect-free; no unconditional retry. |
| Subscription request/ack boundary | Resubscribe identity/cursor and duplicate subscription behavior | Reconnect sequence only; owner fixture required. |
| Effectful command before write | Automatic vs user-driven retry and ID retention | Surface ambiguity; no automatic retry. |
| Effectful command after write, before receipt | Duplicate replay vs marker, retention and restart dedupe | Preserve stable ID for a permitted retry; wait for owner matrix. |
| Receipt received, persistence uncertain | Durable boundary and refresh requirement | Do not mark accepted/current from local observation. |

The matrix must specify retry bound, user-visible category, command ID retention across process restart,
duplicate response shape, and interaction with #189 revision/transaction and #193 receipt persistence.
This is #187/#189/#193-owned policy; it is not an Orca fallback ladder.

## 7. Fail-closed refusal matrix

The `AI_DE_PROTOCOL_*` values below are Orca presentation classes, not a second wire enumeration:
the mapper selects them only from the generated #184/#185 wire code and validation artifact. Exact
wire codes, catalog identity, feature names, and diagnostic limits therefore come from generated
artifacts; an unknown wire value or identity fails closed and is never assigned a guessed class.
A refusal always records a bounded, redacted reason before
IPC/logging; raw frames, secrets, internal paths, stacks, and unbounded server `data` never leave the
main process.

| Trigger | Stable local code | Transport action | Generation/projection/in-flight effect | User category and diagnostic |
| --- | --- | --- | --- | --- |
| Invalid UTF-8 | `AI_DE_PROTOCOL_INVALID_UTF8` | Close and retire generation | Projection `STALE`; requests classified by #187 matrix | Protocol error; code, byte offset (bounded), generation only |
| Partial frame at EOF | `AI_DE_PROTOCOL_PARTIAL_FRAME` | Close and retire | `STALE`; written commands/query ambiguity follows owner matrix | Connection interrupted; no raw fragment |
| Oversized frame/line | `AI_DE_PROTOCOL_FRAME_TOO_LARGE` | Reject and close per #185 contract | `STALE`; in-flight classified as transport outcome | Payload-limit error; observed size bucket only |
| Scalar or batch JSON where one value is required | `AI_DE_PROTOCOL_INVALID_JSON_VALUE` | Reject and close | `STALE`; retire generation | Malformed response; no payload echoed |
| Malformed JSON-RPC envelope or invalid/missing ID | `AI_DE_PROTOCOL_INVALID_JSONRPC` | Reject and close | `STALE`; correlated request classified ambiguous | Protocol error; method/ID hash only |
| Unsolicited/unknown notification or response | `AI_DE_PROTOCOL_UNEXPECTED_MESSAGE` | Reject and close | `STALE`; no projection mutation | Protocol peer error; bounded method name |
| Unnegotiated field/method/feature | `AI_DE_PROTOCOL_UNNEGOTIATED` | Reject and close | `STALE`; no capability widening | Compatibility error; feature identifier only |
| Unknown/mismatched generated `catalog_id` or `schema_identity` | `AI_DE_PROTOCOL_SCHEMA_INVALID` | Reject session and retire generation | No current projection; no discovery/command surface | Contract identity refusal; bounded identity label only |
| Snapshot fails generated validation | `AI_DE_PROTOCOL_SCHEMA_INVALID` | Reject payload; retire generation if #184 marks peer fatal | Keep previous data but mark `STALE`; no current transition | Invalid authoritative data; validator path without value |
| Unknown protocol error code or structured error `data` outside safe schema | `AI_DE_PROTOCOL_UNKNOWN_ERROR_DATA` | Reject response and close unless approved artifact explicitly permits continue | No projection mutation; request outcome follows owner matrix | Unrecognized protocol error; bounded redacted category |
| Endpoint provenance/principal/file type/permission or TOCTOU failure | `AI_DE_PROTOCOL_ENDPOINT_UNTRUSTED` | Do not connect (or close immediately) | No current projection; existing one `STALE` | Endpoint trust error; safe path label only |
| Peer disconnect/timeout | `AI_DE_PROTOCOL_TRANSPORT_AMBIGUOUS` | Retire generation; bounded reconnect | `STALE`; classify each in-flight by request class/point | Connection status; no assumption about effect |
| Older/incomparable update or retired-generation frame | `AI_DE_PROTOCOL_STALE_UPDATE` | Drop frame/update; keep channel if otherwise valid | No projection/UI change; remain at last known status | Silent stale-drop plus bounded diagnostic record |

`continue` is permitted only for the last stale-update row or where a published #185/#184 artifact
explicitly says an isolated error is recoverable. Every close/continue choice must be covered by a
fixture and linked to `FC-N01`–`FC-N08`, `SEC-N01`–`SEC-N04`, or `ERR-N01`–`ERR-N02`. Unknown or
unavailable semantics fail closed rather than choosing a permissive continuation.

## 8. Error and diagnostic mapping

The mapper is table-driven from generated #184 error codes and identity/feature declarations. It preserves the original code and only
contract-permitted structured fields, adds an Orca presentation class, and never collapses distinct
protocol failures. Diagnostic processing occurs before logs or IPC:

1. classify by stable local code and request/generation identity;
2. redact secrets, credentials, internal paths, stack traces, and arbitrary server fields;
3. enforce the #185/#184 maximum byte budget and mark truncation without exposing the original;
4. write to the bounded diagnostic sink and send only the safe record to renderer.

Unknown wire codes, unknown catalog/schema identities, and unknown feature/data values remain
distinguishable but are non-retryable by default; they are not converted into a locally invented
`AI_DE_PROTOCOL_*` wire value. The exact safe envelope,
maximum, and redaction patterns are owner artifacts (`OCP-DIAGNOSTICS`), not local guesses.

## 9. Main, preload, and renderer data flow

```
Host -> main transport/validator -> main authoritative client projection
                              -> immutable replace-only IPC update
                              -> renderer UI replica / derived presentation
```

Main owns socket, generation, ordering, validation, and projection. Each IPC update is tagged with
generation and revision/order identity and replaces the renderer replica wholesale. Renderer rejects
older or incomparable updates, cannot issue arbitrary protocol methods, and cannot modify revision,
receipt, gate, or projection authority. Disconnect retirement sends a stale update; renderer
recreation receives a full replacement before displaying current. Preload allows only the typed
snapshot/subscription/command/status surface to allow-listed renderer contexts/origins under the
managed-profile authorization contract. Discovery, when available, is another typed replace-only
projection surface whose generated method/entity/feature identity and visibility result are checked
in main; it cannot become a local project registry. Unauthorized callers are rejected and recorded.

## 10. Test strategy (design only)

- Codec/session tests use owner-provided transport fixtures for invalid UTF-8, partial EOF, oversize,
  scalar/batch, malformed envelope/ID, unexpected notification, and unnegotiated fields.
- Endpoint/security tests cover provenance, symlink/file type, owner/mode, peer identity, TOCTOU,
  diagnostic redaction/size, and preload caller/profile rejection.
- Generation/reconnect tests assert late-frame rejection, stale propagation, full re-sequence, and
  request-class ambiguity classification.
- Convergence tests assert replacement (no merge), schema rejection, out-of-order monotonicity,
  event-during-snapshot atomicity, gap→resnapshot, and renderer replace-only behavior.
- Discovery tests remain blocked until #209/#184/#186 publish their artifacts; then assert authorized
  Project list, project-scoped WorkItem query, stable ordering, opaque continuation, revision
  consistency, visibility/auth refusal, invalidation-gap→resnapshot, and unknown identity/feature
  fail-closed cases (`DISC-P01`–`DISC-N04`).
- Command tests are blocked until #187/#193 publish the outcome/persistence matrix; then assert
  seen revision, stable ID only for permitted retry, duplicate receipt semantics, conflict/denial,
  and no optimistic mutation.
- Contract-level tests consume generated #184 artifacts and AI-DE fixtures; Orca does not author a
  second schema, fixture, or vector SSOT.

## 11. Post-approval dependency order (S1–S5)

All stages require the Phase 1/design gate and `/approve-design` first. No stage is independent of
unresolved owner contracts.

| Stage | Dependency-ordered content after approval | Required `AVAILABLE` contracts / gate |
| --- | --- | --- |
| S1 | Endpoint/principal validation, NDJSON codec, JSON-RPC session, generation lifecycle, bounded transport backoff | `/approve-design`, #185 `OCP-ENDPOINT` + `OCP-FRAME` + `OCP-CONNECTION`, #184 `OCP-DIST`; no local limits/defaults |
| S2 | Generated artifact import/provenance, initialize negotiation, error/refusal mapper | #184 `OCP-DIST`, `OCP-NEGOTIATION`, `D184-METHODS`, `D184-ERRORS`, `D184-NUMERIC` |
| S3 | Snapshot projection, subscription, event invalidation, owner-defined convergence/order, and available discovery projection | #184 DTO + #186 `OCP-SNAPSHOT`, `OCP-EVENTS`, `OCP-RACE` + #209 `OCP-DISCOVERY` and fixtures |
| S4 | Semantic command dispatcher and receipts | #187 `OCP-COMMAND`, #189/#193 `OCP-RECEIPT` and fixtures |
| S5 | Remote/SSH execution as a configured mode of the same protocol design | #185 `OCP-REMOTE`, endpoint/principal fixture; no separate spec or approval |

If a dependency regresses from `AVAILABLE`, the dependent stage is blocked and the projection is
stale until the manifest/fixture is restored. Stage order changes delivery order only; it never
creates alternate protocol versions.
