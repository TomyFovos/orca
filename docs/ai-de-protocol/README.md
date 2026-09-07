# AI-DE Protocol Client (Orca #64)

Phase 1 design package for the Orca-side client that connects to the AI-DE Protocol Host.
The package is a **candidate**: no production implementation may begin until the human
requirements/design gates and `/approve-design` have completed. S1–S5 below are dependency order
within one approved design, not implementation permission and not a versioned specification split.

Orca's role is fixed by Design Freeze v1.0: **Projection + Command only**. AI-DE State Store is the
runtime state SSOT. Orca may validate, cache, display, and submit contract-defined commands, but it
does not own AI-DE policy, gate authority, provider/model routing, plan generation, or completion.
Events are notifications/invalidation, never a second SSOT.

## Documents

| Document | Phase | Purpose |
| --- | --- | --- |
| [Requirements](requirements.md) | Phase 1 | Scope, actors, functional/non-functional requirements, evidence-gated acceptance mapping, and prohibitions. |
| [Basic design candidate](basic-design-candidate.md) | Design candidate | Module boundaries, lifecycle, ordering invariants, command outcomes, refusal matrix, security boundary, and post-approval dependency order. |
| [Open contract points](open-contract-points.md) | Phase 1/design | Evidence-backed register of owner decisions, reviewed-but-not-approved contracts, unpublished artifacts, and availability blockers. |

## Contract status and gate

Every contract point has exactly one status in [open contract points](open-contract-points.md):

| Status | Meaning |
| --- | --- |
| `OWNER_DECISION_MISSING` | The owning AI-DE issue has not published the decision or required behavior artifact. Orca must not choose a default. |
| `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL` | The owner has recorded a design-level decision/review, but human confirmation and `/approve-design` are still pending. It is not an implementation-ready contract. |
| `APPROVED_NOT_PUBLISHED` | Human approval is recorded, but the generated schema/fixture/conformance artifact is not yet available to consume. |
| `AVAILABLE` | The approved, immutable artifact and acceptance fixture are published and provenance-checkable. Only this status can unblock a contract-dependent implementation/test. |

The status is always tied to an upstream issue/comment and an artifact path (or an explicit
`TBD—owner decision` marker). The AI-DE #184 design-level fulfillment comment (`5478869565`) and
the generated artifact plan under `docs/specs/issue-184-protocol-v1/` are evidence, not a substitute
for human approval or publication. `catalog_id`, `schema_identity`, method/entity registries, and
feature names are admitted only from the published generated artifact and its manifest; Orca may
not define local constants for them. No status or identity may be inferred from a local Orca type.
The `docs/specs/issue-184-protocol-v1/` files are design references only; they are deliberately
separate from the generated export, manifest digest, conformance vectors, and #185/#186 owner
fixtures. No exact published path, digest, or transport value is claimed while those artifacts are
absent, so the dependency remains `DESIGN_REVIEWED_AWAITING_HUMAN_APPROVAL` or
`OWNER_DECISION_MISSING`, never `AVAILABLE`.

## Upstream ownership map

| Contract area | Owner | Boundary and evidence/artifact expected |
| --- | --- | --- |
| Schema SSOT, DTOs, method/entity/error registry, generated distribution, numeric bounds | AI-DE #184 | Design references `docs/specs/issue-184-protocol-v1/03_データ仕様書.md`, `05_API仕様書.md`, and the design-declared export target `artifacts/product-protocol/v1/`; a published path, manifest/digest, and vectors are not yet available (evidence comment `5478869565`). |
| Protocol Host, UDS endpoint/provenance, principal/permissions, UTF-8 NDJSON framing, disconnect and transport limits | AI-DE #185 | Host/endpoint/framing/security/connection decision artifact and negative fixtures; exact path/peer/TOCTOU/limit/generation-retirement values remain owner-owned. |
| Connection generation, disconnect class, bounded reconnect/backoff | AI-DE #185 | `OCP-CONNECTION` decision artifact and fixtures; session start remains blocked until transport recovery and generation retirement are resolved. |
| Snapshot/event semantics, subscribe cursor/gap, watermark/order, refresh race and convergence | AI-DE #186 | Snapshot/event contract and ordering/convergence fixtures; Orca cannot select a race algorithm. |
| Semantic commands, command identity, expected revision, ambiguity/retry/duplicate outcome matrix | AI-DE #187 | Command semantics and disconnect-point matrix; method behavior remains AI-DE-owned. |
| State Store transaction/revision boundary | AI-DE #189 | State Store transaction/revision contract consumed by #187/#186; Orca never becomes a state authority. |
| Large-payload identity/storage and bounded reads | AI-DE #192 | `LargePayloadRef` storage/identity/read bounds; Orca stores references until this artifact is available. |
| `CommandReceipt` persistence and restart/deduplication guarantees | AI-DE #193 | Receipt persistence/restart artifact and fixtures; Orca does not invent retention. |
| Human Decision/requirements/gate authority and binding | AI-DE #202 | Gate/decision contract and stale-approval behavior; Orca displays outcomes only and cannot approve/override. |
| Project and project-scoped WorkItem discovery, ordering/continuation/visibility/auth, invalidation hand-off | AI-DE #209 (method decision) + #184 (generated registry) + #186 (invalidation) | D209/OCP-DISCOVERY decision and owner fixture; generated method/entity/feature bindings, stable ordering and opaque continuation, revision consistency, principal visibility/auth, and invalidation/resnapshot behavior. No git/worktree/terminal/cache inference. |
| Renderer presentation and caller UX | Orca #2 (separate) | UI consumes the main-process replace-only replica; it cannot create protocol authority or bypass preload authorization. |

The owner map is an ownership boundary, not a delegation of AI-DE policy to Orca. Endpoint,
framing, transport recovery, ordering, command retry, error, and diagnostic decisions must each
resolve to one upstream owner and one evidence artifact before the corresponding stage is
implementation-ready.

Schemas are **never hand-copied into this repository**. `catalog_id`, `schema_identity`, method,
entity, error, and feature registries are consumed from the generated #184 SSOT only after the
manifest/provenance verification and owner vectors pass; a local mirror or fallback constant is
not a contract. Remote SSH is a configured execution mode of the same approved contract when #185
publishes it; it is not a later version or a separate approval escape hatch.

## Discovery and review boundary

D209/OCP-DISCOVERY covers the Project list and project-scoped WorkItem discovery query. The owner
decision must define ordering, opaque continuation, revision/consistency metadata, principal
visibility and authorization, structured refusal, and the #186 event-gap/invalidation hand-off.
The exact method/entity names and feature binding arrive through the generated #184 artifact; this
package deliberately records no guessed names, paths, transport values, or digests. Until the
decision is approved and its generated artifact, manifest, and owner fixture are published as
`AVAILABLE`, discovery is unavailable and the client must fail closed rather than infer projects
from git, worktrees, terminal state, SSH, or cache. A design review or local fixture does not grant
implementation permission; the same `/approve-design` and human-gate rule applies to every stage.

## Related repository docs

- [Fork operating constraints](../../ORCA_FORK_OPERATIONS.md)
- [Runtime profile matrix](../reference/runtime-profile-matrix.md) — the `managed` profile is the
  profile under which an external control plane such as AI-DE owns orchestration.
