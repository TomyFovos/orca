# AI-DE Protocol Client — Phase 1 Requirements (Orca #64)

Status: draft candidate, awaiting human requirements/design approval and `/approve-design`.
Issue: TomyFovos/Orca #64, parent EPIC #63
Baseline: `origin/main` at `f05e915a7a`

See also: [category index](README.md) · [basic design candidate](basic-design-candidate.md) · [open contract points](open-contract-points.md)

## 1. Purpose and gate

Define the Orca-side AI-DE Protocol Client so Orca can display AI-DE runtime state and submit
semantic commands without acquiring authority that Design Freeze v1.0 assigns to AI-DE.

This document is not implementation authorization. **No production code in S1, S2, S3, S4, or S5
may start before human requirements/design confirmation and `/approve-design` are recorded.** The
stage labels are dependency order inside one approved specification; they do not define v0.1/v0.2
wire contracts or permit a remote specification to be approved separately.

## 2. Context and fixed boundaries

```
Human -> Orca UI -> main-process AI-DE Protocol Client -> (configured SSH mode) ->
AI-DE Protocol Host -> AI-DE Core / State Store / Execution Runtime
```

AI-DE State Store is the runtime State SSOT. Orca's client projection is authoritative only within
the client process and is always replaceable from State Store snapshots. Event is notification /
invalidation, never SSOT. Orca is **Projection + Command only** and does not own AI-DE policy,
provider/model routing, plan generation, completion determination, retry/fallback policy, gate
authority, or human approval.

## 3. Actors and ownership

| Actor | Owns | Does not own |
| --- | --- | --- |
| Orca UI / renderer | Presentation, user intent capture, replace-only UI replica | State authority, revision changes, gate decisions, protocol method selection |
| Orca main-process client | Endpoint checks, transport, generated validation, negotiated session, validated projection, contract-defined command emission, error/refusal mapping | AI-DE business state machine, policy, receipt durability, race algorithm, authorization decisions |
| AI-DE Protocol Host (#185) | Endpoint/principal, framing, connection enforcement, delegation to Core | Orca presentation |
| AI-DE State Store (#189) | Runtime State SSOT, transaction/revision authority | Orca UI |
| AI-DE contract owners (#184/#186/#187/#192/#193/#202/#209) | Schemas/DTOs, snapshot/event behavior, command semantics, payload identity, receipt persistence, human decision/gate authority, Project/WorkItem discovery decision | Orca-local defaults or a local Project registry |

Ownership details and evidence locations are maintained in [README](README.md) and the
[open-contract register](open-contract-points.md). An unresolved item is a blocker, not an Orca
design choice.

## 4. Contract status rule

Each dependency is labelled `OWNER_DECISION_MISSING`,
`DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL`, `APPROVED_NOT_PUBLISHED`, or `AVAILABLE` in the open
contract register. A dependency is implementation/test-ready only at `AVAILABLE`: human approval,
immutable generated artifact, provenance/manifest check, and owner fixture must all exist. AI-DE #184
comment `5478869565` records design-level fulfillment for distribution, initialize/version/features,
bounded snapshot/continuation/artifact DTOs, and command DTO fields; the comment and source design
files do not waive pending human gates or unpublished artifacts. `catalog_id`, `schema_identity`,
method/entity/error registries, and feature names are admitted only from the generated #184 export
and manifest; a local constant or hand-written mirror cannot satisfy this rule.

## 5. Functional requirements

### FR-0 Phase gate

- FR-0.1 The orchestrator MUST verify human requirements confirmation, design review/approval, and
  `/approve-design` before authorizing any production implementation stage.
- FR-0.2 Design refinement, read-only investigation, interface planning, and contract reconciliation
  MAY proceed while the gate is pending; no generated protocol implementation or host fixture is
  authored in Orca.

### FR-1 Transport, endpoint, and framing

- FR-1.1 The client MUST speak JSON-RPC 2.0 over a Unix domain socket for the local mode.
- FR-1.2 Framing MUST be the #185 UTF-8 NDJSON contract: one complete JSON value per line. The
  client MUST reject malformed encoding, partial EOF, scalar/batch values, and malformed JSON-RPC
  envelopes according to the refusal matrix in the basic design.
- FR-1.3 The connection MUST be persistent and MUST support server-initiated notifications. The
  existing one-request-per-socket CLI transport at `src/cli/runtime/transport.ts:23` does not satisfy
  this and MUST NOT be reused as-is.
- FR-1.4 The client MUST NOT reuse Orca's proprietary envelope at `src/main/runtime/rpc/core.ts:19`.
- FR-1.5 Before connect, the client MUST apply the #185 endpoint/principal contract: provenance and
  canonical path, no symlink or wrong file type, owner/group/permission checks, peer identity where
  supported, and TOCTOU-safe connect. Exact values and platform behavior are owner-owned (OCP-ENDPOINT).
- FR-1.6 Frame/line, concurrent-connection, and in-flight limits and oversize action MUST come from
  #185 (OCP-FRAME), never from a locally selected default.
- FR-1.7 Generation allocation, retirement, disconnect class, and bounded reconnect behavior MUST
  follow the #185 connection contract (OCP-CONNECTION). Transport recovery may continue without a
  JSON-RPC session only while that contract permits it.
- FR-1.8 Any transport/protocol refusal MUST record a stable local code and reason in a bounded,
  redacted diagnostic sink. Unknown or unsafe endpoint/frame input fails closed; it is not retried as
  a different protocol.

### FR-2 Initialize handshake and negotiation

- FR-2.1 The first request on every physical connection MUST be `initialize`.
- FR-2.2 Any non-initialize request before successful initialization MUST be refused locally as well
  as by the host (`NEG-N04`).
- FR-2.3 Re-initialization on an established connection MUST NOT widen capability.
- FR-2.4 The client MUST send its supported protocol version range and offered feature set and accept
  only a host-selected version inside that range, using the generated #184 artifact.
- FR-2.5 Version incompatibility MUST surface as a distinct, non-retryable, user-visible condition
  and MUST NOT silently fall back to legacy behavior.
- FR-2.6 A returned `CapabilityProfile` is advisory projection only. It MUST NOT be treated as
  authorization; the host rechecks authority per command (`NEG-P03`). Gate/Decision authority remains
  #202-owned.
- FR-2.7 Fields and methods bound to features not negotiated MUST NOT be emitted or accepted. An
  unknown/unnegotiated field is a protocol refusal, not an ignored capability widening.
- FR-2.8 JSON-RPC session start is blocked until the #184 distribution artifact is available and the
  negotiated schema/registry can be provenance-checked against OCP-DIST. A transport-only recovery
  does not satisfy this requirement.
- FR-2.9 The client MUST bind `catalog_id`, `schema_identity`, method/entity/error registries, and
  feature registry entries to the generated #184 artifact and verified manifest. It MUST NOT define
  local identity/feature constants or a hand-written fallback. Unknown or mismatched identity,
  method, or feature values MUST fail closed with a bounded refusal reason.

### FR-3 Snapshot acquisition and monotonic projection

- FR-3.1 The client MUST use `workItem/getSnapshot` (generated #184 registry, behavior #186) as the
  authoritative read path.
- FR-3.2 Main process MUST own the validated client projection. A successful snapshot replaces the
  complete projection atomically; merging into a locally evolved model is forbidden (`SNP-P02`).
- FR-3.3 Replacement MUST be monotonic within a connection generation according to the #186-owned
  revision/watermark/order relation. Generation filtering alone is insufficient: an older response
  MUST NOT roll back a newer response. If the relation is unavailable or incomparable, fail closed
  and remain stale.
- FR-3.4 A snapshot failing generated validation MUST NOT become a successful projection (`SNP-N01`).
- FR-3.5 Snapshot content, bounds, truncation, continuation, and consistency metadata are #184/#186
  contract inputs. Orca MUST NOT define a local snapshot shape or revision semantics.
- FR-3.6 Project list and project-scoped WorkItem discovery MUST use only the generated #184 method,
  entity, and feature bindings after the #209 decision and fixture are `AVAILABLE`. The owner
  contract MUST define stable ordering, opaque continuation, revision/consistency metadata,
  principal-scoped visibility and authorization/refusal, and bounded page behavior.
- FR-3.7 Discovery results MUST be replace-only projection data. Invalid continuation, unauthorized
  visibility, missing/unknown identity or feature, and incomparable revision MUST fail closed with a
  bounded reason. #186 event cursor/gap/invalidation MUST schedule the contracted authoritative
  refresh/resnapshot; Orca MUST NOT infer projects from git, worktrees, terminal/SSH state, or cache.

### FR-4 Event subscription and convergence

- FR-4.1 The client MUST support contract-defined subscribe/unsubscribe correlated by subscription
  identity, without disturbing unrelated subscriptions.
- FR-4.2 Events are notification/invalidation only. Event payloads MUST NOT be promoted to
  authoritative state (`EVT-P02`).
- FR-4.3 A state-affecting event MUST schedule the #186-contracted authoritative refresh path; it
  MUST NOT mutate the projection from the event body.
- FR-4.4 Gap, unknown cursor, or retention overflow MUST produce a machine-readable
  `resnapshot_required` outcome. The client MUST NOT fabricate replay (`EVT-N01`).
- FR-4.5 The subscribe/snapshot race algorithm, order identity, and event-during-initial-snapshot
  handling are #186-owned (OCP-RACE). Orca MUST implement exactly the published algorithm and MUST
  not call a projection `CURRENT` after a bare subscribe + snapshot when convergence is unresolved.
- FR-4.6 Concurrent refreshes MUST be serialized/coalesced, compared by contract order identity, or
  coordinated by the contract's request-epoch/queued-dirty rule. The choice is not made in Orca.

### FR-5 Semantic command emission

- FR-5.1 Every semantic command MUST carry a stable `command_id` and the same logical intent MUST
  reuse that ID for any #187-permitted retry. Allocation format, scope, retention, and restart
  deduplication are #187/#193-owned.
- FR-5.2 The client MUST attach `expected_revision` from the snapshot revision the user actually saw
  when forming the intent. Orca MUST NOT increment, repair, or synthesize revisions.
- FR-5.3 The client MUST NOT apply optimistic state transitions. UI changes follow authoritative
  snapshot/receipt confirmation only.
- FR-5.4 The client MUST NOT expose a generic state setter, arbitrary method passthrough, gate
  override, or provider/model routing control.
- FR-5.5 The command method set and semantic outcomes are #187-owned; Orca MUST NOT add commands.
- FR-5.6 `CommandReceipt` follows the #184 DTO / #187 semantics / #193 persistence split. A receipt
  is not authoritative until the owner contract says how it is durable and linked to State Store.
- FR-5.7 Disconnect ambiguity MUST be classified by #187's request-class/disconnect-point matrix.
  Initialization, read-only query, subscription, and effectful command MUST NOT share an unconditional
  retry rule. Until the approved matrix is `AVAILABLE`, no automatic command retry is enabled.

### FR-6 Error mapping and fail-closed refusal

- FR-6.1 Protocol errors MUST map to Orca-side errors while preserving the original machine-readable
  code and contract-permitted structured data after size bounding/redaction.
- FR-6.2 Mapping MUST distinguish at minimum version/feature incompatibility, authority denial,
  capability denial, revision conflict, duplicate command, invariant violation, malformed response,
  endpoint/principal refusal, and transport ambiguity.
- FR-6.3 Transport ambiguity (unknown whether a request reached the host) is a first-class outcome,
  not a plain failure. Retry/resolve behavior comes from #187; no local business fallback is allowed.
- FR-6.4 Every refusal MUST record why it was refused, with stable local code, generation/request
  identity, bounded redacted context, and user-visible category. Fail-closed without a reason is
  incomplete.
- FR-6.5 Error identifiers and validation come from generated #184 artifacts; codes are never
  hand-transcribed. Unknown code or unknown structured `data` is preserved only within the approved
  safe envelope and otherwise rejected according to the refusal matrix.
- FR-6.6 `AI_DE_PROTOCOL_*` values are Orca presentation classes selected by a generated #184/#185
  wire-code/validation mapping. They are not a wire enum or local protocol definition. An unknown
  wire code, catalog/schema identity, feature, or structured error value MUST fail closed and MUST
  retain a bounded refusal reason rather than receive a guessed local mapping.

### FR-7 Generation, reconnect, and recovery

- FR-7.1 Each physical connection MUST carry a generation identifier and every projection update MUST
  carry generation plus the #186 revision/order identity.
- FR-7.2 Frames and renderer updates from a retired generation MUST be ignored/rejected (`EVT-N02`);
  they MUST NOT overwrite current projection or UI replica.
- FR-7.3 Reconnect MUST perform connect, initialize, subscribe, and full snapshot in that order, then
  execute the #186 convergence algorithm. Only after its atomic current transition may projection be
  `CURRENT` (`EVT-P04`).
- FR-7.3a Reconnect may remain transport-only after connect or disconnect recovery if the #185
  connection contract requires generation retirement before a session can start; in that state the
  client MUST NOT begin JSON-RPC session traffic.
- FR-7.4 Complete replay of missed events MUST NOT be assumed. Any gap uses the contracted resnapshot.
- FR-7.5 While disconnected or convergence-uncertain, main projection and renderer replica MUST be
  marked stale rather than shown as current.
- FR-7.6 If Orca stops while the host continues, Orca MUST rebuild solely from a new authoritative
  snapshot (`EVT-N03`); local persisted projection is not a second SSOT.

### FR-8 Main/preload/renderer boundary

- FR-8.1 Main process is the sole owner of socket, generation, validation, ordering, and client
  projection. It publishes immutable **replace-only** snapshots to the renderer tagged with generation
  and revision/order identity.
- FR-8.2 Renderer holds only a UI replica/derived view. It MUST reject older or incomparable updates,
  never merge protocol fields, and replace the entire replica on accepted updates.
- FR-8.3 Disconnect/generation retirement MUST propagate stale status through IPC. Renderer recreation
  MUST receive a full replacement before becoming current.
- FR-8.4 Preload exposes a narrow typed API (snapshot read, subscription lifecycle, command submission,
  status) only to the allow-listed renderer contexts/origins and managed profile. Unauthorized callers
  are rejected and cannot invoke arbitrary methods or gate operations (OCP-IPC-CALLER).
- FR-8.5 Server diagnostic data is bounded and redacted before logging or IPC; raw secrets, paths,
  stacks, or unbounded `data` never cross the boundary (OCP-DIAGNOSTICS).
- FR-8.6 Discovery and Gate/Human Decision commands cross preload only through generated, typed
  caller-authorized surfaces. Orca MUST send no local optimistic gate/decision authority, generic
  method passthrough, or Project registry; #202 remains the caller/gate owner.

## 6. Non-functional requirements

- NFR-1 Contract artifacts are consumed, never hand-copied. Once #184 publishes distribution details,
  a manifest/provenance and drift check MUST run before use (OCP-DIST).
- NFR-2 Transport reconnect backoff MUST be bounded and non-amplifying according to the #185
  connection contract. It is not a semantic command retry or fallback policy.
- NFR-3 No secret material (tokens, keys, `.env` values, or internal diagnostic payloads) may be
  logged, embedded, or exposed to renderer.
- NFR-4 New code lives in domain-named modules separate from Orca runtime authority (proposed root
  `src/main/ai-de-protocol/`), making Projection + Command boundaries auditable.
- NFR-5 Local UDS and remote SSH are configuration modes of the same approved protocol design. Remote
  mode may not be a staged specification split or a separate approval escape hatch; it remains
  unavailable until #185 publishes its endpoint/principal/forwarding contract and fixture.
- NFR-6 Refusal diagnostics have a contract-defined maximum size, deterministic redaction, and a
  bounded sink. The client never logs raw wire frames.

## 7. Out of scope (Design Freeze v1.0 prohibitions)

- Re-implementing the AI-DE business state machine in Orca.
- Treating events as SSOT or allowing renderer state to become an authority.
- Owning policy decision, plan generation, provider/model routing, completion determination, gate
  authority, or semantic retry/fallback policy.
- Copying AI-DE schemas, error enums, fixtures, or vectors into this repository.
- Screen-level UI work (owned by Orca #2).
- Placeholder type definitions or locally selected defaults for undecided contract areas.

## 8. Acceptance and traceability

### 8.1 Readiness rule

An acceptance case is `READY-CONTRACT` only when every owner dependency is `AVAILABLE`, the generated
manifest verifies, and an owner-provided fixture/conformance vector exists. No acceptance case is
currently `READY-CONTRACT`; all cases below are design targets blocked by the statuses in the open
contract register. A local mock or a reviewed-but-unapproved design does not satisfy this rule.

### 8.2 Positive and negative case map

| Requirement area | Cases to provide | Current dependency/blocker |
| --- | --- | --- |
| Initialize/negotiation | `NEG-P01`–`NEG-P04`, `NEG-N01`–`NEG-N05` | #184 reviewed design awaits approval/publication (`OCP-DIST`, `OCP-NEGOTIATION`); exact catalog/schema identity and feature bindings are not locally selectable. |
| Framing/fail-closed | `FC-N01` invalid UTF-8, `FC-N02` partial EOF, `FC-N03` oversize, `FC-N04` scalar/batch, `FC-N05` malformed JSON-RPC/id, `FC-N06` unsolicited/unknown notification, `FC-N07` unnegotiated field, `FC-N08` unknown structured data | #185 limits/close semantics and #184 error artifact missing (`OCP-FRAME`, `OCP-DIAGNOSTICS`). |
| Endpoint/security/IPC | `SEC-N01` endpoint provenance/symlink, `SEC-N02` file type/owner/perms, `SEC-N03` peer identity/TOCTOU, `SEC-N04` diagnostic redaction/size, `SEC-N05` unauthorized preload caller | #185 and Orca #2/#202 decisions/fixtures missing (`OCP-ENDPOINT`, `OCP-IPC-CALLER`). |
| Snapshot replacement/validation | `SNP-P01` valid authoritative replacement, `SNP-P02` no merge, `SNP-N01` schema-invalid snapshot | #186 behavior and #184 artifact not available (`OCP-SNAPSHOT`). |
| Project/WorkItem discovery | `DISC-P01` authorized Project list, `DISC-P02` project-scoped WorkItem query with stable order/opaque continuation/revision, `DISC-N01` invalid continuation, `DISC-N02` visibility/auth refusal, `DISC-N03` revision or invalidation gap→resnapshot, `DISC-N04` unknown generated identity/method/feature | #209 decision/fixture is missing and #184 generated catalog plus #186 invalidation artifact are not `AVAILABLE` (`OCP-DISCOVERY`). |
| Event/invalidation/reconnect | `EVT-P01` subscription identity, `EVT-P02` event does not mutate state, `EVT-P03` gap→resnapshot, `EVT-P04` reconnect sequence, `EVT-N01` unknown cursor, `EVT-N02` late retired generation, `EVT-N03` restart rebuild | #186 event/gap/order fixture missing (`OCP-EVENTS`, `OCP-RACE`). |
| Ordering/race | `ORD-P01` monotonic replacement, `ORD-N01` out-of-order refresh cannot roll back, `ORD-N02` event during initial snapshot converges atomically | #186 normative algorithm/fixture missing (`OCP-RACE`). |
| Commands/receipts | `CMD-P01` command uses seen revision, `CMD-P02` accepted→authoritative refresh, `CMD-P03` duplicate replay, `CMD-P04` structured denial, `CMD-N01` ambiguous read classified, `CMD-N02` bounded same-ID command retry, `CMD-N03` duplicate has owner-defined receipt, `CMD-N04` revision conflict; `PERSIST-N01` restart/dedup | #187 outcome matrix and #189/#193 transaction/persistence missing (`OCP-COMMAND`, `OCP-RECEIPT`). |
| Large payload | `LRG-P01`, `LRG-P03`, `LRG-N03`, `LRG-N04` | #184/#186/#192 identity, bounds, and failure artifact missing (`D184-LARGE-REF`). |
| Contract vectors/catalog | `CAT-P01`, `VEC-P01`, `VEC-P03`, `VEC-N01` | #184 human approval/public export/manifest/vectors missing; catalog/schema identity and feature registry must come from that generated artifact, never a local mirror. |
| Error/diagnostic mapping | `ERR-P01` safe structured error, `ERR-N01` unknown code/data, `ERR-N02` redaction/size bound | #184/#185 safe error envelope and diagnostic limits are not published (`D184-ERRORS`, `OCP-DIAGNOSTICS`). |
| Gate/profile | `GATE-N01` stale approval cannot authorize, `IPC-N01` profile/caller change revokes surface | #202 gate binding and caller artifact missing. |

### 8.3 Requirement-to-negative traceability

| Requirement | Minimum negative cases |
| --- | --- |
| FR-1 endpoint/framing | `SEC-N01`–`SEC-N03`, `FC-N01`–`FC-N06` |
| FR-2 initialize/features | `NEG-N01` version mismatch, `NEG-N02` unsupported feature, `NEG-N04` pre-init request, `NEG-N05` unnegotiated field, `FC-N07` unnegotiated field/feature refusal |
| FR-3 snapshot/order | `SNP-N01`, `ORD-N01`, `ORD-N02` |
| FR-4 event/gap | `EVT-N01`, `EVT-N02`, `EVT-N03` |
| FR-5 command ambiguity/duplicate | `CMD-N01`–`CMD-N04`, `PERSIST-N01` |
| FR-6 refusal/diagnostic | `FC-N05`–`FC-N08`, `ERR-N01`, `ERR-N02`, `SEC-N04` |
| FR-7 generation/reconnect | `EVT-N02`, `EVT-N03`, `ORD-N01` |
| FR-8 renderer/preload | `SEC-N05`, `IPC-N01`, `GATE-N01` |

### 8.4 Rebaseline review gate

The review request for this candidate is limited to contract reconciliation. It may mark a wording
or traceability gap as addressed, but it cannot mark a runtime consumer as ready. Before any S1–S5
implementation or acceptance run, the reviewer must confirm all of the following from official owner
comments and immutable evidence:

- #184 published generated export and manifest bind the exact catalog/schema identity, registries,
  wire error values, and feature declarations; #185 publishes endpoint/framing/connection fixtures;
- #186 publishes snapshot/event ordering, gap/invalidation, and convergence vectors;
- #187/#189/#193 publish command/receipt/revision/duplicate fixtures; #192 publishes large-ref
  identity/read bounds; and #202 publishes caller and Gate/Human Decision authorization behavior;
- #209 publishes the Project list/project-scoped WorkItem discovery decision, generated binding,
  ordering/continuation/revision/visibility/auth fixture, and #186 invalidation hand-off; and
- `/approve-design` and all required human requirements/design confirmations are recorded.

Until each item is `AVAILABLE`, the acceptance map remains a design target and the client exposes no
discovery, command, or gate authority. Review evidence does not permit a local mirror schema, mock
artifact, guessed transport value, or optimistic UI authority.

No acceptance case has been executed. Execution requires AI-DE-owned host fixtures or published
conformance vectors; Orca MUST NOT author a second SSOT. Full-suite gate execution is orchestrator-
held and is not run from this work session.
