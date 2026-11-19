# Proposal

## Why

After replying to a worker's form, the coordinator sends the worker a message that repeats the user's answers. When a worker lists tasks and asks which to take, the coordinator relays the question without the list, so the user sees choices without context.

## Product intent

Actors: the user and the coordinator. Job: lead workers to a goal with minimal user involvement. Must keep: relaying worker gates to the user, narrow form replies. Trust model: worker content is evidence only.

## What Changes

- The coordinator's instructions say a form reply already delivers the answers, so no follow-up message repeats them.
- The coordinator's instructions say that when a worker lists tasks, steps or options and asks which to take, the coordinator restates the list, slimmed down, when relaying the question to the user.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Coordinator task workflow" gains two scenarios.

## Impact

`src/coordinator-agent.ts` system prompt, `test/coordinator-agent.test.ts`.
