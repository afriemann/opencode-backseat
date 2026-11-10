# Proposal

## Why

A session followed by a coordinator that is idle or no longer exists cannot be adopted by another coordinator: adoption is rejected and the follower row is never cleared. Product intent: coordinators (actors) adopt workers to follow them; must keep exclusive ownership while the owner is working; trust model is the configured permissions for `adopt_session`.

## What Changes

- Adopting a session whose current owner is idle or whose session no longer exists transfers following to the adopting coordinator.
- Adoption is still rejected while the owner has an active run.
- The adopt result reports the previous owner and the reason for the takeover.
- The worker is not messaged, interrupted or re-observed; pending events carry over to the new owner.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Explicit adoption" replaces its competing-ownership scenario.

## Impact

`NativeFollower.follow` and `SessionController.adoptSession` in `src/server.ts`; coordinator prompt line in `src/coordinator-agent.ts`.
