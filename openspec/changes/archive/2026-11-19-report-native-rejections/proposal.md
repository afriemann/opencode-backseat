# Proposal

## Product intent

Actors: a human user and the coordinator model driving Backseat tools. Job: coordinate native sessions and answer their permission requests reliably. Must keep: reading and replying to pending permissions, retryable failure reporting. Trust model: the host is trusted; its typed rejections are expected outcomes, not connection faults.

## Why

When the host rejects a request with a typed error (for example a permission request that no longer exists), the coordinator is told the native service connection is unavailable, so it retries or investigates the connection instead of the request. The `reply_permission` tool description also never names its `decision` field, and models send the host's own field name instead.

## What Changes

- A typed host rejection during a native operation is reported as a rejection naming the error class, not as an unavailable connection.
- The `reply_permission` description names the `decision` argument.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Actionable native failure reporting" gains a rejection scenario.

## Impact

`src/native-connection.ts`, `src/native-operations.ts`, `test/native-connection.test.ts`.
