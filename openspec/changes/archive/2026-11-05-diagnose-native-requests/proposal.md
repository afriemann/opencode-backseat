# Proposal

## Why

Native inventory failures can report an overall timeout without identifying which native request failed or remained pending. Operators need useful exception diagnostics without exposing sensitive native data.

## What Changes

- Add request-category, request-duration, HTTP-status and allowlisted error-code diagnostics at the native connection boundary.
- Extend the existing host-log privacy projection for those bounded fields.
- Preserve coordination results, sanitized caller errors, permissions and cancellation.

## Capabilities

### Modified Capabilities

- `worker-coordination`: extend operational diagnostics and their privacy boundary for native requests.

## Impact

Implementation is limited to `src/native-connection.ts` and `src/server.ts`, with coverage in `test/native-connection.test.ts` and `test/worker-supervision.test.ts` and diagnostics documentation in `README.md`.

No deadline increases, automatic retries, deployment-pin changes, service restarts, new dependencies or caller-facing API changes are included.
