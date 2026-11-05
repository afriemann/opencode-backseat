# Design

## Decisions

- **Native controls:** Explicit typed tools/adapters use installed 2.2.5 contracts and origin-locked transport, not public passthroughs or deprecated aliases. Shared admission preserves operation-bound approval, post-approval caller/target validation, automatic-decision fencing, exclusive child adoption and coordinator confinement.

- **Incremental reads:** Bounded paging and exclusive durable-log checkpoints use expiring caller/service/target/query-bound handles. Keep message anchors separate from event sequences; refetch unfinished messages. Distinguish correlation from activity; report discontinuity without mirroring transcripts.

- **Delivery retirement:** Reuse serialized store authority and reserve deterministic invocation/native IDs before effects; reconcile inbox/history/events without fabricated tasks. Keep 800 live records, not lifetime admissions. At capacity, retire only admitted records carrying verified initiating-message proof, oldest timestamp first. Atomically publish deletion and a store-wide non-decreasing expiry cutoff covering every retired timestamp. Reject absent invocations whose verified timestamp is at/below cutoff, including ties; no bounded tombstones or wall-clock expiry.

  Internal adapters fetch the initiating coordinator message through pinned `session.message.get({sessionID,messageID})`; verify service, selected message ID, assistant type and finite nonnegative `time.created`. Persist that time with session/message/tool-call/kind identity before reservation. Missing/unverifiable metadata rejects new admission without effects; retained records remain inspectable/reconcilable without resending.

  Recheck cutoff and duplicate identity inside serialization after asynchronous approval/lookups, immediately before reservation. Unreserved in-flight calls can expire; reserved/ambiguous records remain pinned, never replaced/retried. Only the reserving call executes; late completion cannot recreate retired rows. Publication failure holds admission.

  Versioned decoding preserves v1/v2 tasks, counters and uncertainty; new-format readers enforce proof/cutoff and incompatible readers reject. Legacy records without proof remain non-retirable, never inferred from local `createdAt`. Exhaustion by unresolved/legacy records visibly holds rather than discards identities.

- **Supervision:** Shared server-owned, task-isolated evaluations retain finite prompt-only limits. Approved generations fence on identity/service/ownership/project loss; recovery inventories before approved rearming. Manual authority remains separate.

- **Agent-only surface:** Remove terminal entrypoints, commands, visual artifacts, possession proofs and exclusive dependencies. Retain authenticated identity/shared RPC only; no second interface, upgrade or deployment.
