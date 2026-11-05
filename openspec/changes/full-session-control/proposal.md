# Proposal

## Why

The coordinator cannot read the sessions it manages, follow responses to its messages, or perform the full native session lifecycle. Task-binding and terminal-only control assumptions obstruct conversational coordination; the user wants everything controlled through the agent.

## What Changes

- Add bounded, iterative session history and activity reads, including responses anchored to a coordinator send and updates to ongoing responses.
- Expose the native session-control surface, including lifecycle, prompting and attachments, execution, inbox, agent/model selection, context, compaction, revert, permissions, forms, instructions and environment controls. Ordinary interaction does not require a supervised task binding.
- Move automatic supervision orchestration into the server with explicit agent-mediated start, hold, resume and recovery. Preserve finite limits, reconciliation and uncertain-delivery identities without terminal attachment.
- Remove top-level-only adoption and superseded terminal-specific restrictions. Retain operation-bound native approval, correct-service/target validation and confinement to Backseat tools.
- Keep manual authority separate from autonomous follow-ups; fence stale decisions after manual mutations and preserve ownership and delivery identities without inventing task bindings. Since-send reads distinguish activity from causal attribution. Server generations require approved rearming after authority loss; populated stores retain reconciliation state.
- **BREAKING**: remove the TUI entrypoint, commands, visual controls and unused UI dependencies rather than maintaining a second control interface.

## Capabilities

### Modified Capabilities

- `worker-coordination`: native session content and full control, child adoption, agent-only authority and removal of terminal-only prerequisites.
- `worker-supervision`: server-owned observation and automatic follow-ups controlled through the coordinator agent.
- `coordination-tui`: remove terminal coordination capabilities.

## Impact

Changes affect server/tool/native adapters, supervision lifecycle and state, coordinator instructions, package exports and dependency lock, tests and host harness, task-runner targets, and contributor/user documentation. The shared native identity RPC remains where required. No dependency upgrade, deployment, or production mutation is included.
