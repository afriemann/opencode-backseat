# Proposal

## Why

Session inventory can exhaust its operation deadline while classifying rows that the requested limit or metadata filters exclude. Repeated pending-form reads add avoidable latency.

## What Changes

- Bound native inventory pages by the requested result limit and exclude metadata mismatches before status reads.
- Share validated pending-form snapshots per location and refresh, without per-form detail requests.
- Preserve fresh status classification, honest degradation, filter semantics and query-bound continuation.
- Keep scanning bounded even when filters yield short or empty pages, and recheck refreshed metadata before returning rows.
- Limit snapshots to one refresh, isolate location failures and aggregate overflow, and preserve supervision and control eligibility semantics for shared-helper consumers.
- Demonstrate reduced hydration for small-limit and selective metadata queries, with form reads scaling by selected locations rather than sessions or forms; do not promise completion when an individual host request stalls.

## Capabilities

### Modified Capabilities

- `worker-coordination`: bounded native session inventory queries.

## Impact

Production changes are confined to `src/native-sessions.ts` and `src/tools.ts`, with regression tests, affected fixtures and pagination guidance in `README.md`. No deadline, dependency, service identity or approval changes; no deployment or service restart.
