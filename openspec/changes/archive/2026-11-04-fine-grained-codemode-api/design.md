# Design

## Boundaries

Register dedicated structured CodeMode tools in `src/tools.ts`, namespace `conman`, without model-facing inspect/control aliases. Retain possession-bound internal TUI RPC. Reuse `native-sessions.ts` readers and serialized backend authority; add no datastore, mutation tool or authority pipeline.

Backend identity remains authoritative. Allow coordinator `execute` composition; reject unrelated nested tools through execution hooks. Preserve operation-specific consent, configured denials and `forceNativeAsk`. Adoption/takeover verify top-level identity before/after approval. Shared-context schemas describe existing snapshot and version-reference fields.

## Discovery and continuation

Use bounded native streaming, not full snapshots; pagination is observational. Push supported filters down; postfilter others. Expose hierarchy and roots. Archived visibility never implies inactivity; status conflicts remain unknown, excluded by default. Task-dependent filters require task authority; other native discovery remains independent.

Keep native cursors/buffers behind caller/query/service-incarnation-bound handles: five-minute absolute expiry, maximum 128, invalidated on unload/reconnect. Expiry/eviction requires restarting. Each call scans at most 200 native rows with eight concurrent session projections, not eight total HTTP requests; per-projection reads retain native request timeouts/bounds. Empty filtered pages may continue; exhaustion alone completes pagination.

## Deletion

Use approved native recursive removal, including execution interruption and concurrent descendants, without an atomic expected-set guarantee. Verify coordinator ancestry before/after approval; incomplete/cyclic ancestry fails closed. Protect coordinator/ancestors. Both preapproval/postapproval collected subtrees reject any retained pending/uncertain overlap.

Journal deletion separately from sends in the existing shared store; durably fence known affected tasks before removal. Preserve all history/delivery identities. In-flight automation admission cannot be revoked.

Expose task-scoped `get_task` diagnostics from that journal. Reconciliation records only currently observed native presence/absence/unknown as evidence. Absence never rewrites retained pending/uncertain outcomes into successful deletion or non-delivery. Admit no retry.

## Runtime risk

Documentation/types support all-tool hooks; installed 2.2.5 nested-dispatch acceptance remains unverified.
