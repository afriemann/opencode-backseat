# Proposal

## Why

The coordinator cannot start a worker in a checkout that the host tracks as an additional directory of a project (for example a renamed or worktree checkout), because discovery offers only a project's canonical and sandbox paths. Workers also stay blocked on pending forms or permissions when the coordinator sends them other input, and history reads return pages small enough that the coordinator reports worker content as cut off.

## Product intent

Actors: a user driving a coordinator over parallel worker sessions. Job: start and steer workers in any of their project directories without sessions stalling or content being cut off. Must keep: worker gates relayed to the user; bounded, handle-based reads. Trust model: worker content is untrusted evidence.

## What Changes

- Project discovery also lists each project's other directories reported by the host, so `create_session`, `list_agents` and `list_models` accept them.
- The coordinator is instructed to close a followed session's pending form or permission request before sending that session other input.
- Content reads default to larger pages (128,000 bytes) and accept up to 1 MiB.

## Capabilities

### Modified Capabilities

- `worker-coordination`: adds project directory discovery, extends manual assignment with gate closure, and extends content pagination with the larger default page.

## Impact

`src/native-sessions.ts`, `src/coordinator-agent.ts`, `src/native-content.ts`, and their tests.
