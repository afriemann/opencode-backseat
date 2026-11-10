## Decisions

### Time filters

Native `session.list` (client 2.2.5) has no time filters, so filters run client-side before hydration, inside the existing 200-row per-call scan bound. Native sorts by `time_updated`, ties by id, which allows early stop: descending with `updatedAfter`, ascending with `updatedBefore`, once a row proves no later row can match. `subpath` goes to native, which matches it exactly and only together with a project. Before is exclusive, After inclusive; inputs are ISO-8601 or Unix ms, anything else is rejected. This avoids a second index or cache.

### Hydration budget

Budget is 5 s, a child abort signal separate from the 10 s connection deadline. It leaves about 5 s for identity checks, the second `session.active()` and revalidation. It covers only per-row status hydration batches, not the shared `active()`/permission/form reads: those run once, are needed for correct status, and are bounded by the deadline. The budget starts after them. Tests inject a signal factory (default `AbortSignal.timeout`) instead of fake timers.
Unhydrated rows stay buffered in the continuation, never returned as `unknown`, so the status field never lies. Every call hydrates at least one batch, so the cursor always advances. Result is `partial: true`. A connection-level abort still fails the call.

### `hydrate`

Default true. `hydrate:false` returns metadata rows with status `unknown`, makes no status reads, and rejects `statuses`. `hydrate` and all new filters join the continuation fingerprint, so a cursor cannot be replayed under different semantics.

### Continuation retention

A failed native read keeps continuations when the class is timeout or cancelled. Disposed, and registration or identity validation failures, clear them, since the buffered state may belong to a stale connection. Retention never extends the TTL.

### Failure classification

Existing classes are reused (disposed, timeout, cancelled, validation, transport, unknown). The thrown message carries one fixed safe label: timed out, cancelled, disposed, unavailable. It never contains URLs, headers or registration content. The bare catch blocks in `readNativeInventory` and `refreshNativeSessions` keep a sanitized diagnostic cause (class plus label) rather than discarding the error, so diagnostics stay useful without leaking sensitive content.

## Rationale

Smallest change that makes enumeration succeed under load: bound the optional work (hydration), not the mandatory work (identity), and make failures retryable and honest.
