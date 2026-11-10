# Proposal

## Product intent

Primary actor: the user, who is the sole operator and trusts the coordinator. Job: one coordinator reads whole worker sessions and takes full control of any session, approving through host permissions. Must keep: complete unredacted transcripts, control of every listed session, any native agent as worker. Trust model: the host's allow/ask/deny rules are the only gate.

## Why

Backseat defaults and caps stop the coordinator from reviewing or controlling sessions even when the host would allow it: exports are redacted, large reads fail, archived sessions cannot be controlled, following stops at 128 sessions, and some agents cannot be used.

## What Changes

- Session export returns unredacted content by default; redaction is opt-in. An omitted and an explicit `sanitize: false` are the same query for continuation.
- A content read is fetched once and served from a per-handle snapshot, so chunks are consistent and cost is linear; the 8 MB result cap is replaced by a single finite memory budget for snapshots with an explicit capacity error. Page size limits stay as pagination.
- Continuation handles use a sliding idle lifetime of one hour; least recently used handles are evicted first.
- Archived sessions can be read, adopted, updated (including unarchive) and deleted; the coordinator's own identity check stays.
- Workers can be created, switched to or imported with any native agent except coordinators.
- Send text and operation string fields no longer carry a 12,000-character cap; one byte bound per payload remains, with its value set in design.
- Unpaged native lists (projects, agents, models, pending forms and permissions, inbox) no longer fail above 200 rows; worker discovery pages without a total cap; delivery reconciliation scans the whole history and stops at the match.
- The follower count rises from 128 to 1024, bounded by the persisted-state byte limit.
- Tool descriptions and README state the new defaults.

## Capabilities

### Modified Capabilities

- `worker-coordination`: content pagination, full controls, explicit adoption, background followed-session events.

## Impact

`src/native-content.ts`, `src/native-sessions.ts`, `src/native-operations.ts`, `src/server.ts`, `src/state.ts`, `src/tools.ts`, tests and README. Unredacted exports enter the coordinator transcript and the model provider context, and the coordinator could forward them with any tool it may call; the user accepted this. Content never enters state files, logs or diagnostics.
