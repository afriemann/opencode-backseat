# Proposal

## Why

Selecting an existing session for coordinator management currently triggers an unnecessary task questionnaire, then can fail because an unreleased owner record outlives its process. Ordinary coordination should facilitate the user's request without requiring invented work or a separate dead-owner recovery ceremony.

## What Changes

- Permit approved adoption without a task or a new exclusive-ownership ledger; preserve explicitly requested task binding and use takeover for an eligible existing binding. Reuse selected-session context, ask only genuine selection or outcome ambiguity, and never require fabricated task fields or placeholder criteria.
- Automatically reacquire a demonstrably terminated owner's store during startup authority acquisition, independently of session adoption approval or supervision start. Preserve state and keep automatic supervision held until separately approved reconciliation.
- Report specific authority blockers for live owners, unverifiable ownership, unsafe storage and unavailable host capabilities rather than a generic unavailable-runtime error.
- Preserve native operation approval, competing-ownership exclusion, uncertain-delivery reconciliation, privacy boundaries and unchanged worker execution during adoption.

## Capabilities

### Modified Capabilities

- `worker-coordination`: explicit adoption, conversational manual assignment and exclusive coordinator authority, preserving child-session targeting.

## Impact

Changes are confined to `src/coordinator-agent.ts`, `src/tools.ts`, `src/server.ts`, `src/ownership.ts`, `test/tools.test.ts`, `test/worker-coordination.test.ts` and `README.md`. Omitted task is distinct from malformed task; unavailable task authority remains an explicit error, never evidence of no binding. No dependencies, persistent task schema, worker prompts, agent selections or operational service changes are introduced.
