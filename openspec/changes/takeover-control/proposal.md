# Proposal

## Why

Managing an existing session should not require inventing a task, sending a message, or satisfying supervision snapshot gates. The coordinator needs background events and direct native controls so it can carry out the user's instructions without repeated Backseat approval prompts.

## What Changes

- Creating or adopting a selected native session immediately follows it without sending initial input.
- Background progress, idle, failure, permission and form events wake its coordinator with identifiers needed to inspect and act.
- The coordinator uses native controls and answers worker requests according to the user's instructions and its judgment. OpenCode's configured permissions remain authoritative; Backseat does not force allowed operations to ask.
- **BREAKING:** Remove task bindings, shared-task snapshots, evaluator-driven supervision, start/resume gates and their tools. No compatibility layer or generic action-rule engine is retained.
- Bind following to the initiating coordinator and explicitly selected session, with stopping and reload recovery. Persist notification progress and uncertain native delivery identities. Retain native discovery, bounded content, hierarchical controls, diagnostics and the evidence/instruction distinction.
- **BREAKING:** Replace the task-store format without migrating task records; incompatible state is reported, not overwritten. Task evaluation limits disappear with the evaluator; notification transport remains bounded and excludes self-feedback.

## Capabilities

### Modified Capabilities

- `worker-coordination`: session-centric takeover, background following, event delivery and controls governed by configured permissions.
- `worker-supervision`: remove task evaluation, automatic prompt dispatch and supervision-generation requirements.
- `task-context`: remove task-scoped evaluation and snapshot sharing.

## Impact

Rewrite the server, tools, state, storage and ownership layers; adapt native helpers and RPC contracts; remove the five task/supervision modules. Update the coordinator definition, contributor instructions, README and corresponding tests. Dependencies, development-session permissions, deployment and live-session state are unchanged.
