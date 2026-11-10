# Proposal

## Product intent

Primary actor: the user, who is the sole operator and trusts the coordinator. Job: the coordinator quickly learns what a worker session accomplished without paging through its transcript, and drills into subagent sessions on demand. Must keep: control of every session through host permissions. Trust model: host allow/ask/deny rules gate each call.

## Why

Reading a whole session to understand it is slow and fills the coordinator's context.

## What Changes

- New coordinator tool `recap_session` asks the session's own model for a recap (goal, work done, current state, open problems, next steps), inserting no message.
- The result also lists the session's direct child sessions (id, title, agent, status); the coordinator recaps a child by calling the tool again with that id.

## Capabilities

### Modified Capabilities

- `worker-coordination`: Full native session controls.

## Impact

`src/native-operations.ts`, `src/coordinator-agent.ts`, tests, README. The transcript is sent to the session's configured model.
