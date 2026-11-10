# Proposal

## Why

A coordinator that tells a worker how to do its job (what to skip, waive or satisfy) overrides the worker's own configured instructions and lifecycle, so the worker can bypass its own gates.

## Product intent

Actors: a user and the coordinator agent. Job: delegate work to workers and follow them. Must keep: send work, relay worker gates. Trust model: the worker's own configuration governs how it works.

## What Changes

- The coordinator prompt instructs it to pass requests on as stated, never prescribe or override a worker's process, and relay a worker's own gates to the user unless the user delegated the decision.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Conversational manual assignment" gains a scenario preserving worker lifecycle.

## Impact

`src/coordinator-agent.ts` system prompt; `test/coordinator-agent.test.ts`.
