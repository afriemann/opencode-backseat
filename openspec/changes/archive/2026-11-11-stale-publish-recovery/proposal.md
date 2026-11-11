# Proposal

## Why

An interrupted state publish leaves a `.publish-<uuid>` temporary file in the coordination store. Every later startup treats it as unsafe storage and holds coordination permanently, with only a generic "unavailable" message and no recorded cause.

## Product intent

Actors: the user and the coordinator agent. Job: coordinate parallel sessions reliably. Must keep: coordination survives a crashed or interrupted write. Trust model: the store directory is private to the user.

## What Changes

- Opening a writable store removes stale `.publish-<uuid>` files that are regular, user-owned, single-link files; any other unexpected entry still holds storage.
- A failed publish removes its own temporary file.
- A coordinator held at startup retries acquisition on each storage-backed call, so repairing the store needs no service restart.
- A held-at-startup coordinator records the sanitized blocker reason in its `setup.degraded` diagnostic.

## Capabilities

### Modified Capabilities

- `worker-coordination`: "Shared durable coordination store" gains stale-publish recovery.

## Impact

`src/storage.ts`, `src/server.ts`, `test/worker-coordination.test.ts`.
