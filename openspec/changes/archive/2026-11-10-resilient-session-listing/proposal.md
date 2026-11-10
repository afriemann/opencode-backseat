## Why

`list_sessions` fails on a loaded host: the whole native read (identity checks plus status hydration of up to 50 sessions) shares one 10 s deadline. A timeout surfaces as a generic "unavailable or unsupported" error, and every native error discards all stored continuations, so the retry also fails. The coordinator cannot enumerate sessions (for example to find stale ones) and cannot tell a timeout from an outage. It also cannot narrow queries by time.

## Product intent

Primary actor: the coordinator agent, acting for one user. Job: enumerate, filter and page native sessions across projects (for example "stale for 5 days") and know honestly whether the result is complete. Must keep: listing, filtering, paging, honest partial and unknown reporting. Trust model: only the verified same-service native connection; the coordinator is trusted to read metadata.

## What Changes

- Add filters `updatedBefore`, `updatedAfter`, `createdBefore`, `createdAfter` (ISO-8601 or Unix milliseconds) and `subpath`.
- Add `hydrate` (default true). With `false`, rows carry metadata only, status is `unknown`, and no status reads occur. Combining `hydrate:false` with `statuses` fails explicitly.
- Status hydration runs under a time budget. When the budget is spent, remaining rows stay in the continuation and the result is `partial: true`, instead of failing the call.
- A failed native read no longer discards stored continuations, so the same cursor can be retried.
- Native failures are classified (timeout, cancelled, disposed, unavailable) in the error text and diagnostics, without exposing URLs, headers or registration contents.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirements "Native session inventory" and "Automatic same-service native connection".

## Impact

`src/tools.ts` (schema, filters, cursor handling), `src/native-sessions.ts` (hydration budget, hydrate-less inventory), `src/native-connection.ts` (failure classification), the coordinator prompt in `src/coordinator-agent.ts`, `README.md`, and tests. The `list_sessions` input schema gains optional fields only.
