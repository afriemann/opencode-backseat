## Decisions

1. **Snapshots.** A content read fetches the export once (unredacted unless `sanitize: true`) and stores the parsed result in memory under the handle. Chunks are slices of that snapshot. One global budget of 256 MiB of snapshot bytes (serialized size) covers all handles. If a new snapshot does not fit after evicting idle handles, the read fails with a `snapshot_capacity` error naming the budget. Snapshots live in memory only, never in state files, logs or diagnostics.

2. **Handle lifetime.** The TTL is 1 hour and slides on each use. Eviction is LRU by last use, triggered when the budget is exceeded. The handle count rises to 1024 with LRU eviction.

3. **Payload bound.** Send text and operation payloads share one bound: 32 MiB of serialized UTF-8 bytes per payload. Host limits are unknown, so this is a high finite value that still stops runaway memory use. It sits above any realistic prompt, and the host rejects anything it cannot take. The 12,000-character `maxLength` on strings (`native-operations.ts`, `tools.ts`) and the array item caps are removed. The bound is checked once on the serialized payload.

4. **State counts.** The 8 MiB state byte bound stays as the real guard. `FOLLOW_BOUNDS.followers` rises from 128 to 1024; writes beyond the byte bound fail with the existing state-capacity error.

5. **Archived sessions.** Archived-session rejection is removed only in `SessionController.target` and the reconciliation paths in `native-sessions.ts`. `matchesExecutionRole` keeps its coordinator identity check.

6. **Coordinator exclusion.** One shared predicate, `isCoordinatorAgent`, uses the existing coordinator definition recognition. Create, switch agent and import call it and reject coordinators. Every other native agent is allowed.

7. **Reconciliation.** The scan pages through the full history and stops at the first match. There is no seen-set. Cursor-loop detection stays: a repeated cursor ends the scan with an error.

## Trust model

Host permissions are the only gate. Unredacted export content is held only in handle snapshots and returned to the coordinator.
