# Proposal

## Why

The live coordinator rejects its own resolved definition when OpenCode appends configured permission grants. The same mismatch skips its restricted tool catalog, so availability and the three-tool boundary need to work together under effective native policy.

## What Changes

- Recognize matching coordinator semantics independently of inherited permission suffixes; do not claim native authorship provenance.
- Enforce the coordinator's restricted tools at both model-context and native execution boundaries while preserving configured denials and operation-specific consent.
- Preserve unrelated configured agents and reject changed coordinator definitions. An exact configured copy has the same restricted behavior, not additional authority.
- Keep one coordinator able to manage approved workers across projects using the shared store.

## Capabilities

### Modified Capabilities

- `worker-coordination`: coordinator recognition and restricted execution under merged native policy, including semantic-equivalent configured definitions.

## Impact

`src/coordinator-agent.ts` is owned by agent-engineer; runtime integration touches `src/server.ts` and `src/tui.ts`. Existing worker-coordination, coordination-TUI and private-host tests cover realistic inherited policy and execution rejection. README explains the effective-policy guarantee.

No new dependency, configuration setting, provenance registry, storage migration or RPC is introduced. Global configuration, native consent, task scope, worker isolation and explicit supervision remain unchanged. Implementation, review, commit and archival are local; live verification is read-only and launches no workers.
