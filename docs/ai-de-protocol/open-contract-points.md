# AI-DE Protocol Client — Open Contract Points (Orca #64)

Status: evidence register for Phase 1. This is **not** a list in which every line is blindly
undecided. Each point has an explicit owner, evidence, status, publication requirement, and
acceptance blocker. Orca must not resolve a point whose status is `OWNER_DECISION_MISSING`, and it
must not treat a reviewed or approved-but-unpublished point as implementation-ready.

See also: [category index](README.md) · [requirements](requirements.md) · [basic design candidate](basic-design-candidate.md)

## Status vocabulary

| Status | Meaning and allowed action |
| --- | --- |
| `OWNER_DECISION_MISSING` | The owning AI-DE issue has not published the required decision/behavior artifact. Orca exposes a seam only; it chooses no default. |
| `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL` | The owner recorded a design-level decision/review, but human confirmation and `/approve-design` are pending. Design may be reconciled; production implementation is forbidden. |
| `APPROVED_NOT_PUBLISHED` | Human approval is recorded, but the immutable generated artifact, manifest, or fixture is not published. Contract-dependent implementation/tests remain blocked. |
| `AVAILABLE` | Approved artifact and acceptance fixture are published, immutable, and provenance-checkable. This is the only status that unblocks a dependent implementation/test. |

Status changes require a new upstream issue comment and artifact evidence. The current AI-DE #184
design-level fulfillment comment (`5478869565`) and files under
`docs/specs/issue-184-protocol-v1/` are design evidence only: the index records pending human
requirements confirmation and `/approve-design`, and the generated export is not yet published.
`APPROVED_NOT_PUBLISHED` and `AVAILABLE` are therefore transition states, not assumptions.
The same rule applies to catalog identity: `catalog_id`, `schema_identity`, method/entity/error
registries, and feature names are read from the generated export and manifest, never from local
constants or a hand-written mirror.

## Register

### OCP-ENDPOINT — UDS endpoint, principal, and TOCTOU

- **Owner / status:** AI-DE #185 · `OWNER_DECISION_MISSING`
- **Evidence:** #185 issue scope names endpoint path and permission semantics; no authoritative
  endpoint/principal artifact is published.
- **Required artifact:** `TBD—#185 endpoint/principal decision + platform fixtures` covering path
  provenance, canonicalization, symlink and file-type rejection, owner/group and permission rules,
  peer identity, replacement between validation and connect (TOCTOU), and remote-mode endpoint.
- **Missing decision:** exact checks and failure behavior, including which peer credentials are
  available on each supported platform.
- **Acceptance block:** `SEC-N01`, `SEC-N02`, `SEC-N03`, `REMOTE-P01`, and the transport-only
  half of S1/S5 implementation.
- **Orca interim posture:** validate before connect and fail closed on any unverifiable property;
  do not compile a permissive path or principal default.

### OCP-FRAME — UTF-8 NDJSON framing and limits

- **Owner / status:** AI-DE #185 · `OWNER_DECISION_MISSING`
- **Evidence:** #185 host/framing scope and its malformed/disconnect DoD; exact limit artifact is
  absent.
- **Required artifact:** `TBD—#185 framing contract + negative fixtures` defining UTF-8 handling,
  line termination, maximum frame/line bytes, oversize response (reject vs close), partial EOF,
  scalar/batch JSON, concurrent connections, and per-connection in-flight limits.
- **Missing decision:** every limit and whether a violation retires the generation.
- **Acceptance block:** `FC-N01`–`FC-N08`, `NEG-N01`–`NEG-N04`, and the transport-only half of S1
  implementation.
- **Orca interim posture:** codec accepts injected contract values only; no compiled-in ceiling,
  fallback framing, or locally invented recovery.

### OCP-CONNECTION — generation, disconnect, and bounded recovery

- **Owner / status:** AI-DE #185 · `OWNER_DECISION_MISSING`
- **Evidence:** #185 owns disconnect handling, transport limits, and bounded reconnect behavior; no
  generation-retirement artifact is published.
- **Required artifact:** `TBD—#185 connection/backoff contract + fixtures` covering generation
  allocation and retirement, disconnect class, bounded recovery vs stop, backoff base/max/jitter,
  exhaustion behavior, load ceiling, and evidence fixtures.
- **Missing decision:** whether a transport-only recovery may continue after disconnect or retire the
  generation immediately for each class.
- **Acceptance block:** S1 transport-only recovery, `NFR-2`, and every JSON-RPC session start until
  this contract and the #184 distribution artifact are both available.
- **Orca interim posture:** keep transport recovery and JSON-RPC session readiness separate; a
  recovered transport does not imply a session may start.

### OCP-DIST — contract artifact distribution and provenance

- **Owner / status:** AI-DE #184 · `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`
- **Evidence:** comment `5478869565` records generated distribution as design-level fulfilled;
  `docs/specs/issue-184-protocol-v1/02_基本設計書.md` describes export root,
  manifest digests, and `import-ai-de-product-protocol.js --check`.
- **Required artifact:** an approved and published export (the current
  `artifacts/product-protocol/v1/` location is a design-declared target, not evidence that it
  exists) containing schema, declarations, validator, API reference, vectors, and
  manifest/provenance digest. The export must bind the exact `catalog_id`, `schema_identity`,
  method/entity/error registries, and feature registry consumed by Orca; those values may not be
  supplied by a local fallback.
- **Missing decision/state:** human approval and publication; exact consumer pin/update command must
  be frozen in the manifest before status can become `AVAILABLE`.
- **Acceptance block:** `VEC-P01`, `VEC-P03`, `VEC-N01`, NFR-1, and the JSON-RPC session half of S1
  plus S2 implementation.
- **Orca interim posture:** no schema/types/vectors are copied or vendored; adapter remains an
  interface until an approved manifest passes drift/provenance checking, and session start stays
  blocked until the approved distribution is available.

### OCP-NEGOTIATION — initialize, version, and feature selection

- **Owner / status:** AI-DE #184 · `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`
- **Evidence:** comment `5478869565`; `03_データ仕様書.md` initialize DTO and six-feature registry;
  `04_詳細設計書.md` validation/refusal rules. Human gate and generated publication remain pending.
- **Required artifact:** the approved generated initialize schema, version grammar, feature registry,
  selection precedence, and optional-feature emission/acceptance vectors, including the exact
  `catalog_id`/`schema_identity` binding. The client maps generated wire values to presentation
  classes; it must not invent a local version or feature constant.
- **Missing decision/state:** publication and acceptance fixture; Orca must not implement a legacy
  fallback or capability widening.
- **Acceptance block:** `NEG-P01`–`NEG-P04`, `NEG-N05`, and S2 implementation.
- **Orca interim posture:** first request is initialize; unresolved mismatch is a recorded,
  non-retryable refusal.

### OCP-SNAPSHOT — authoritative snapshot shape and bounds

- **Owner / status:** AI-DE #186 behavior + AI-DE #184 DTO · `OWNER_DECISION_MISSING`
- **Evidence:** #184 comment `5478869565` records bounded snapshot/continuation/artifact DTOs at
  design level (`03_データ仕様書.md`, `05_API仕様書.md`); #186 owns when/how snapshots establish
  State Store truth, but has not published that behavior artifact.
- **Required artifact:** #186 snapshot behavior/consistency contract and fixture, joined to the
  approved #184 generated DTO (content, bounds, truncation, revision/watermark, continuation).
- **Missing decision:** authoritative consistency metadata and replacement eligibility.
- **Acceptance block:** `SNP-P01`, `SNP-P02`, `SNP-N01`, `ORD-N01`, and S3 implementation.
- **Orca interim posture:** cache only a generated-validated opaque snapshot plus contract-defined
  order identity; never merge fields or infer a revision.

### OCP-EVENTS — subscription, cursor, gap, and invalidation

- **Owner / status:** AI-DE #186 · `OWNER_DECISION_MISSING`
- **Evidence:** #186 issue scope/comments require Event as invalidation and reconnect snapshot; exact
  subscription/cursor semantics are not published.
- **Required artifact:** subscription identity, event cursor/sequence, retention window, gap/overflow
  signal, event-during-snapshot behavior, and negative/positive fixtures.
- **Missing decision:** what constitutes a safe refresh trigger and which order identity is carried.
- **Acceptance block:** `EVT-P01`–`EVT-P04`, `EVT-N01`–`EVT-N03`, `ORD-N02`, and S3 implementation.
- **Orca interim posture:** event bodies never mutate projection; unknown cursor/gap forces the
  contracted resnapshot path, never fabricated replay.

### OCP-RACE — snapshot/event ordering and convergence algorithm

- **Owner / status:** AI-DE #186 · `OWNER_DECISION_MISSING`
- **Evidence:** #186 ordering/race responsibility is recorded in issue scope; no algorithm artifact
  or fixture exists. Possible shapes (revision/watermark comparison, serialized/coalesced refresh,
  or request epoch plus queued-dirty) are alternatives, not Orca decisions.
- **Required artifact:** one normative algorithm with comparison relation, atomic transition to
  `CURRENT`, handling of events observed during initial snapshot, and out-of-order fixture vectors.
- **Missing decision:** all ordering/race semantics; Orca must not call itself current after a bare
  subscribe + snapshot.
- **Acceptance block:** `ORD-P01`, `ORD-N01`, `ORD-N02`, `EVT-P03`, and S3 implementation.
- **Orca interim posture:** expose a strategy seam with no default. A stale/unknown relation is
  fail-closed until the owner artifact is available.

### OCP-COMMAND — command identity, revision, and semantic outcomes

- **Owner / status:** AI-DE #187 semantics + AI-DE #184 DTO + AI-DE #193 persistence ·
  `OWNER_DECISION_MISSING`
- **Evidence:** #184 comment `5478869565` records `command_id`, `expected_revision`, and
  `CommandReceipt` DTOs at design level; #187 owns semantic outcome and ambiguity behavior; #193
  owns persistence. Neither the complete outcome matrix nor published fixtures are available.
- **Required artifact:** #187 matrix by request class and disconnect point (automatic vs user retry,
  retry bound, ID retention and restart scope, duplicate shape), approved DTO, and #193 persistence
  guarantees/fixtures.
- **Missing decision:** duplicate replay vs marker, idempotency retention, expected-revision
  granularity, and whether any retry may be automatic.
- **Acceptance block:** `CMD-P01`–`CMD-P04`, `CMD-N01`–`CMD-N04`, and S4 implementation.
- **Orca interim posture:** retain one logical intent/ID only as a data-flow seam. Dispatcher is not
  implementation-ready and may not unconditionally retry or classify every disconnect alike.

### OCP-RECEIPT — State Store transaction and receipt persistence boundary

- **Owner / status:** AI-DE #189 + AI-DE #193 · `OWNER_DECISION_MISSING`
- **Evidence:** #189 owns State Store transaction/revision semantics; #193 owns mutable
  `CommandReceipt` persistence. Orca has no authority artifact.
- **Required artifact:** transaction boundary, revision source/atomicity, receipt retention and
  restart/deduplication fixture, linked from #187 command behavior.
- **Missing decision:** when a receipt is durable and which result a duplicate may replay.
- **Acceptance block:** `CMD-P03`, `CMD-N02`, `CMD-N03`, `PERSIST-N01`, and S4 implementation.
- **Orca interim posture:** await authoritative receipt; no local outbox, revision increment, or
  duplicate database.

### OCP-REMOTE — remote UDS execution mode

- **Owner / status:** AI-DE #185 · `OWNER_DECISION_MISSING`
- **Evidence:** #185 owns host endpoint/transport; existing Orca TCP forwarding is not a Unix-socket
  bridge. No remote-mode contract/fixture is published.
- **Required artifact:** SSH/remote endpoint, principal, forwarding, disconnect, and security
  behavior as a configured mode of this same protocol design.
- **Missing decision:** remote path and peer verification; no separate versioned specification or
  later approval may be introduced.
- **Acceptance block:** `REMOTE-P01`, `REMOTE-N01`, and the post-approval S5 configured-mode work.
- **Orca interim posture:** local and remote are configuration choices under one approved contract;
  if remote is not approved, it remains unavailable rather than silently falling back.

### D184-METHODS — canonical method and entity registry

- **Owner / status:** AI-DE #184 · `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`
- **Evidence:** comment `5478869565`; `05_API仕様書.md` method registry including
  `workItem/getSnapshot`, event methods, commands, and `artifact/readContent`.
- **Required artifact:** generated registry in the published v1 export and method conformance vectors.
- **Missing decision/state:** human approval/publication; no Orca-side spelling or registry may drift.
- **Acceptance block:** `CAT-P01`, `VEC-P01`, and S2–S4 implementation.
- **Orca interim posture:** `catalog_id`, `schema_identity`, names, and feature bindings are
  references only and are accepted from generated artifacts; no local registry or fallback spelling.

### D184-NUMERIC — JSON-safe numeric bounds

- **Owner / status:** AI-DE #184 · `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`
- **Evidence:** #184 schema design and comment `5478869565`; generated numeric constraints are not
  published.
- **Required artifact:** approved schema/vector bounds and representation for revisions, cursors,
  identifiers, and byte counts.
- **Missing decision/state:** human approval/publication of validators.
- **Acceptance block:** `CAT-P01`, `FC-N05`, `VEC-N01`.
- **Orca interim posture:** no local number coercion or hand-written range; unknown identity or
  bound is a refusal until the generated validator is available.

### D184-ERRORS — protocol error enumeration

- **Owner / status:** AI-DE #184 · `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`
- **Evidence:** `04_詳細設計書.md` error/refusal model and comment `5478869565`; generated enum is
  not published.
- **Required artifact:** generated error-code/data schema and vectors, including unknown-code behavior.
- **Missing decision/state:** human approval/publication; unknown codes must remain distinguishable.
- **Acceptance block:** `ERR-P01`, `ERR-N01`, `FC-N08`, and S2 implementation.
- **Orca interim posture:** table-driven mapper generated from the published artifact only; no
  hand-transcribed codes. Unknown wire code/data is a bounded fail-closed refusal.

### D184-LARGE-REF — large payload reference and `artifact/readContent`

- **Owner / status:** AI-DE #184 DTO + #186 behavior + #192 storage · `OWNER_DECISION_MISSING`
- **Evidence:** #184 comment `5478869565` and `P184-DEC-002` establish a bounded public query and
  DTO shape; #192 read bounds/identity/failure behavior is not published.
- **Required artifact:** generated DTO plus #192 identity/storage/read bounds and #186 behavior
  fixtures.
- **Missing decision:** chunking, stable identity, expiry, failure and redaction semantics.
- **Acceptance block:** `LRG-P01`, `LRG-P03`, `LRG-N03`, `LRG-N04`.
- **Orca interim posture:** retain the reference; do not dereference or invent chunk limits.

### OCP-DIAGNOSTICS — bounded/redacted diagnostics

- **Owner / status:** AI-DE #185 transport/security + AI-DE #184 error DTO ·
  `OWNER_DECISION_MISSING`
- **Evidence:** #185 malformed/disconnect fail-closed scope and #184 safe-error design are broad;
  no approved size/redaction artifact is published.
- **Required artifact:** diagnostic maximum bytes, redaction rules for server data/paths/stacks,
  logging sink schema, and renderer-safe presentation fixtures.
- **Missing decision:** what data may cross log and IPC boundaries and how truncation is signaled.
- **Acceptance block:** `ERR-N02`, `SEC-N04`, `FC-N01`–`FC-N08`.
- **Orca interim posture:** record stable local code/category and bounded redacted metadata only;
  never emit raw server `data`, secrets, paths, or stacks.

### OCP-IPC-CALLER — preload caller and managed-profile authorization

- **Owner / status:** Orca #2 UI boundary + AI-DE #202 gate context · `OWNER_DECISION_MISSING`
- **Evidence:** runtime profile matrix identifies `managed`; #202 owns decision/gate authority.
  No #64 caller/origin authorization artifact is frozen.
- **Required artifact:** allow-listed renderer contexts/origins, managed/default profile checks,
  authorization failure UX, and renderer recreation fixtures.
- **Missing decision:** which caller may invoke the typed preload surface and how profile changes
  invalidate it.
- **Acceptance block:** `SEC-N05`, `IPC-N01`, `GATE-N01`.
- **Orca interim posture:** narrow typed preload only; reject unauthorized callers and never expose a
  generic method passthrough or gate override.

### OCP-DISCOVERY — Project list and project-scoped WorkItem discovery

- **Owner / status:** AI-DE #209 method/decision + #184 generated registry + #186 invalidation ·
  `OWNER_DECISION_MISSING` (official #209 remains `NEEDS_DECISION`).
- **Evidence:** #209 identifies a missing Project list and Project→WorkItem discovery contract;
  #184 design documents a registry but no published discovery artifact; #186 owns event-gap and
  invalidation behavior. No local Orca implementation or fixture is authoritative.
- **Required artifact:** an approved D209 decision and owner fixture that define the generated
  method/entity/feature binding, Project list and project-scoped WorkItem query shape, stable
  ordering, opaque continuation token, revision/consistency metadata, principal-scoped visibility
  and authorization/refusal behavior, bounded results, and the #186 invalidation/gap→resnapshot
  hand-off. The #184 manifest must bind the resulting catalog and identity.
- **Missing decision/state:** #209 has not selected the registry-vs-provisioned-endpoint model;
  exact names, fields, limits, refusal codes, and visibility semantics must not be inferred from
  git, worktrees, terminal/SSH state, or cache. A local list is not a Project registry or SSOT.
- **Acceptance block:** `DISC-P01`–`DISC-P02`, `DISC-N01`–`DISC-N04`, and any snapshot/event stage
  that would advertise a discoverable project.
- **Orca interim posture:** expose no discovery surface until the artifact is `AVAILABLE`. Once
  available, consume only generated names and values, replace results from the authoritative query,
  retain opaque continuation without interpretation, and schedule #186's contracted invalidation
  refresh. Unknown method/feature, missing identity, unauthorized visibility, invalid continuation,
  or incomparable revision fails closed with a bounded refusal reason.

## Acceptance readiness rule

An acceptance case is `READY-CONTRACT` only when **every** owner dependency in this register is
`AVAILABLE`, its generated artifact manifest verifies, and the owner fixture/conformance vector is
present. A reviewed design or local mock is not sufficient. The current register has no
`READY-CONTRACT` cases; the cases below are traceable design targets and remain execution-blocked:

| Dependency status | Design targets | Why execution is blocked |
| --- | --- | --- |
| #184 `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL` | `NEG-N01`–`NEG-N05`, `CAT-P01`, `ERR-P01`, `VEC-*` | Human gates, generated export, manifest, and vectors are not published; JSON-RPC session start remains blocked. |
| #185 `OWNER_DECISION_MISSING` | `FC-*`, `SEC-*`, `REMOTE-*`, `NFR-2` | Endpoint/principal, framing limits, diagnostics, generation retirement, and fixtures are unresolved. |
| #186 `OWNER_DECISION_MISSING` | `SNP-*`, `EVT-*`, `ORD-*` | Snapshot/event behavior and ordering/race algorithm are unresolved. |
| #187/#189/#193 `OWNER_DECISION_MISSING` | `CMD-*`, `PERSIST-*` | Ambiguity/retry/duplicate matrix and receipt transaction/persistence are unresolved. |
| #192 `OWNER_DECISION_MISSING` | `LRG-*` | Large-payload identity/read behavior is unresolved. |
| #202/Orca #2 `OWNER_DECISION_MISSING` | `GATE-*`, `IPC-*` | Gate authority and caller/origin authorization artifacts are unresolved. |
| #209 `OWNER_DECISION_MISSING` | `DISC-*` | Project list/project-scoped WorkItem method, ordering/continuation/revision, visibility/auth, generated identity, and #186 invalidation artifact are unresolved; no discovery surface is available. |

When an owner publishes and human approval is recorded, move the point through
`APPROVED_NOT_PUBLISHED` until its immutable artifact and fixture are available; only then may the
orchestrator relabel dependent cases `READY-CONTRACT`.

## Related decided items

- `P184-DEC-001`: Phase is a Protocol v1 public entity and typed subject of `phase.changed`.
- `P184-DEC-002`: `artifact/readContent` is the bounded public query for `LargePayloadRef` (the
  bounds and storage behavior remain #192/#186-owned as recorded above).
