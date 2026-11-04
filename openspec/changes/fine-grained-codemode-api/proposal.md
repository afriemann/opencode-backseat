# Proposal

## Why

The coordinator cannot reliably continue redacted pagination cursors or query sessions by project and activity. A fine-grained Code Mode API makes discovery and explicit coordination composable without generic operation/body multiplexers.

## What Changes

- **BREAKING:** replace direct inspection/control tools with structured, namespaced Code Mode discovery, task-detail and individual control tools; remove redundant generic tools and aliases.
- Filter hierarchical session listings by multiple statuses, project/location, task, agent, title, parent and archived inclusion. Default to running, waiting and inactive, excluding unknown. Keep native continuation cursors internal and preserve query semantics across bounded pages.
- Expose dedicated project, agent and task catalogs, retaining native discovery independently of task storage unless a task-dependent filter is requested.
- Enable coordinator Code Mode composition while denying unrelated nested tools and preserving operation-specific consent, configured denials and optional automation authority.
- Limit adoption and takeover to top-level sessions, enforced independently of coordinator instructions.
- Add explicit native-subtree deletion with approval covering execution interruption and descendants resolved during removal, not an atomic pre-enumerated-set guarantee. Protect the invoking coordinator and its ancestors, preserve coordination history and all delivery identities, and never retry uncertain deletion silently.

## Capabilities

### Modified Capabilities

- `worker-coordination`: fine-grained Code Mode discovery, control, continuation and deletion.

## Impact

Server adapter, extracted tool registry, native session readers, RPC contracts, permission boundaries, bundled coordinator instructions, tests and README. Existing possession-bound TUI RPC remains internal; model-facing generic tools are removed. No dependency upgrade, deployment, global configuration change, live-session mutation during verification, push, PR or retained-worktree removal.
