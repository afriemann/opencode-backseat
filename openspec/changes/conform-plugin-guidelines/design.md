## Context

`matchesExecutionRole` makes four host lookups per call and runs on every `context` event. `admissionDiagnostic` writes to stderr from `SessionController` and `NativeFollower`, which are exported and constructed without the plugin. `fingerprint(input)` in `sendSession` hashes the whole send input.

## Goals / Non-Goals

- Goals: one logging path, a cheap `context` hook, visible model-facing text.
- Non-goals: changing enforcement, storage, dependencies or CI.

## Decisions

1. **Role latch.** The `context` hook caches only a successful `matchesExecutionRole` result in a `Map` keyed by `sessionID` plus agent id, holding the in-flight promise so concurrent calls share one lookup. A rejected lookup deletes its entry and keeps the fail-closed `event.tools = {}` branch, so an error is never latched. The map is bounded (256, oldest evicted) and cleared on dispose. A stale entry can only misreport the catalog, never enforcement: `execute.before` keeps the full live check and remains the gate. Not subscribing to `session.moved` avoids a subscription for a catalog-only effect.

2. **Logging.** `SessionControllerHost` gains an optional `diagnostics: DiagnosticEmitter`, forwarded to the follower host; when absent nothing is logged and nothing writes to stderr. New `DIAGNOSTIC_EVENTS`: `setup.configured`, `tool.denied`, `catalog.filtered`, `admission.uncertain`, `follower.degraded`. The ten admission call sites map to the last two with `classification` and `operation` labels only; `errorClass` is dropped. The config log carries the fixed runtime label `v2`, plugin and host versions (each only if it matches `\d+\.\d+\.\d+`) and the names of options that were set; option values are never logged.

3. **`synthetic` description.** Validation trims and rejects a blank string. `description` already enters `fingerprint(input)`; `reconcile` reads the stored delivery record, not the description, so reconciliation is unaffected. The follower notification uses one module constant.

4. **Spec scope.** Besides the two requirements in the proposal, "Diagnostic privacy boundary" is modified so version labels join the allowlist. The latch and other internal log output are not spec'd.

## Risks / Trade-offs

- A stale latch can briefly leave built-in tools in the coordinator catalog after a definition override; `execute.before` still rejects them.
- Dropping `errorClass` loses stderr detail for operators; the closed classification remains.
- Requiring `description` breaks callers that omit it; the validation error is the only migration path.
