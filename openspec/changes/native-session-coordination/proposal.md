# Proposal

## Why

Parallel OpenCode work currently requires an external session manager or manual switching, making agent selection and cross-project supervision cumbersome. A native coordinator should keep work aligned without mixing unrelated task context or requiring another application.

## What Changes

- Introduce one conversational entry point for managing new and existing worker sessions across local projects and splitting larger objectives into related tasks.
- Provide event-driven supervision that continues, redirects, holds, escalates or completes work against its approved goal, with bounded automatic follow-up prompts only.
- Keep task context separate by default while allowing explicit, versioned sharing within task groups; sharing information does not expand approved scope.
- Offer a compact native terminal interface for project and agent selection, worker status, adoption, opening workers and manual takeover.
- Retain coordination state across plugin reloads without silently repeating dispatches or reviving held work.
- Require an approved connected native TUI and passive observers loaded in worker projects; reconnect inventories state before explicit rearming, without another service connection.
- Require explicit worker ownership; manual takeover invalidates pending automatic follow-ups.
- Treat worker output and shared material as untrusted evidence, never consent or control authority. Automatic prompts cannot answer approval requests or override holds.
- Visibly hold ambiguous deliveries, incompatible APIs and failed supervision; reconcile rather than blindly retry. Durable task-level continuation limits prevent indefinite loops.

## Capabilities

### New Capabilities

- `worker-coordination`: Task goals, worker bindings, cross-project creation/adoption and explicit control.
- `task-context`: Task-scoped reasoning and deliberate shared context for related tasks.
- `worker-supervision`: Goal-based continuation, redirection, holds, escalation and completion decisions.
- `coordination-tui`: Native terminal discovery, selection, status and worker navigation.

## Impact

New OpenCode V2 server and TUI entrypoints with typed RPC and durable state, using one canonical home per local service. The minimum target is V2.2.5 on Linux with trusted `/usr/bin/flock`; experimental APIs and later hosts require explicit compatibility handling.

Excluded: external dashboards, V1 support, remote-service management, automatic permission replies, automatic scope approvals, deployment, publication and worker-project/global configuration edits or activation. Interrupting work is not rollback or guaranteed external termination.
