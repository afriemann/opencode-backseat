# Proposal

## Why

Coordinator discovery includes subagent sessions alongside primary sessions, making the default inventory noisy. Callers need primary sessions by default without losing deliberate child-session discovery.

## What Changes

- **BREAKING**: exclude child sessions from default `list_sessions` results.
- Add the optional boolean `includeSubagents` to opt into hierarchical discovery.
- Preserve explicit `parentID` selection as an override of the default hierarchy selection.
- Keep other filters, continuation safeguards and session-ownership restrictions unchanged.

## Capabilities

### Modified Capabilities

- `worker-coordination`: native session inventory hierarchy selection.

## Impact

Update `src/tools.ts`, `test/tools.test.ts`, `README.md` and the coordinator discovery instructions in `src/coordinator-agent.ts`. No dependencies, deployment changes, new components or changes to native session ownership are included.
