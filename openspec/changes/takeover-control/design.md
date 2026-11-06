# Design

## Decisions

### Local follower core

Use one service-owned core, serialized mutations and existing anchored storage/flock. Lock acquisition permits automatic recovery; contention reports unavailable ownership. Persist coordinator ownership per exact worker, preventing competing adopters. No implicit descendant expansion.

`Follower = {sessionID, coordinatorID, location, generation, afterSeq, pending, delivery}`. Internal operations are `follow(target, caller)`, `stop(sessionID, caller)`, `ingest(event)` and `flush(coordinatorID)`. Create/adopt calls `follow` immediately; native sends remain independent.

### Durable replay and transient intake

Subscribe before baseline capture. Anchor adoption at `log.synced`. Replay durable execution/tool events through bounded `experimental.session.log({sessionID, after, follow:false})`, independent of since-send tracking; sequences deduplicate replay. Global `permission.asked` (`data.id/sessionID`), `form.created` (`data.form`) and `session.idle` (`data.sessionID`) enter persisted pending summaries directly, not log replay. Reconcile native pending permission/form snapshots at adoption, reload and transient overflow, deduplicating request IDs. Restart replays committed durable cursors automatically. Lost sequence boundaries or observation gaps produce coordinator-visible discontinuity, not invented transient history; idle transitions during downtime cannot be replayed.

### Bounded coordinator delivery

Cap followers at 128. Coalesce progress for 500 ms into latest sequence/count; retain idle/failure flags and distinct request IDs. Bound batches to 128 request IDs and 16 KiB; leave durable cursors before unrepresented events and retain an overflow/reconciliation marker for transient requests. Deliver one immutable batch per coordinator through queued, resuming synthetic input. Worker content is evidence, not user instruction; judgment stays with the coordinator.

Persist batch identity/text before admission; reconcile reserved/uncertain outcomes. Commit cursors atomically with summaries. Unknown admission retries identical immutable synthetic ID/text in the same coordinator session; native session/type/ID deduplication preserves first admission, including delivered records. Never allocate replacement IDs; other workers remain observable.

### Stop and feedback

Serialized stop removes followers and unsent summaries; generations fence asynchronous intake. Admitted notifications do not recreate following. Reject self-follow and coordinator-worker cycles; ignore notification-origin events.

### Store and controls

Use a version-3 envelope containing followers and native delivery identities. Reject incompatible/corrupt state without writing; no migration or reset. Keep typed native controls and operation-bound permission assertions, removing forced-ask overrides. Remove task/evaluator/supervision modules and task RPC contracts; retain authenticated identity RPC. No replacement policy engine, distributed ownership or compatibility layer is justified.
