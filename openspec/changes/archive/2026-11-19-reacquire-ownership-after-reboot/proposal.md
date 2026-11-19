# Proposal

## Product intent

A user coordinates parallel OpenCode sessions from one coordinator conversation. Must keep: listing, following and controlling sessions after a host restart. Trust model: a single local user; the exclusive kernel lock already excludes concurrent same-host owners.

## Why

After a host reboot, an ownership record left unreleased by the previous boot is classified as unverifiable. The coordinator stays held and every coordination tool reports "Coordination owner identity is unverifiable" until the lock file is edited by hand.

## What Changes

- An unreleased ownership record written under a different boot is treated as terminated, since no process survives a reboot, so the store is reacquired.
- A record under the same boot but a different PID namespace stays unverifiable.

## Capabilities

### Modified Capabilities

- `worker-coordination`: "Exclusive coordinator authority" gains a scenario for reacquisition after a reboot.

## Impact

`src/ownership.ts` (`ownerStatus`), `test/worker-coordination.test.ts`, `openspec/specs/worker-coordination/spec.md`.
