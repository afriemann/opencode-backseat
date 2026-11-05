# Proposal

## Why

Coordinators cannot tell when listed sessions were created or how recently they were updated. Native OpenCode metadata already provides this information.

## What Changes

- Add numeric `createdAt = time.created` and `updatedAt = time.updated` to `list_sessions` rows, both Unix milliseconds. `updatedAt` indicates general update recency, not strict conversation activity.
- Preserve existing filtering, ordering, status and continuation behavior without introducing activity tracking or storage.

## Capabilities

### Modified Capabilities

- `worker-coordination`: expose session timestamps in inventory.

## Impact

Additive public output-contract change in `src/native-sessions.ts` and `src/tools.ts`, with corresponding assertions in `test/tools.test.ts` and documentation in `README.md`. No dependency changes.
