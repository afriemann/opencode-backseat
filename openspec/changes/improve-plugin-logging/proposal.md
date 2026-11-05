# Proposal

## Why

Backseat's native inventory failures cannot be distinguished from connection, timeout, or validation failures using current diagnostics. Silent degradation and inconsistent boundary logs make operational diagnosis unnecessarily dependent on reproducing failures.

## What Changes

- Provide consistent structured lifecycle, tool, RPC, hook, and background diagnostics through one never-throw host-integrated emitter with constant service `backseat`, injected into native modules.
- Identify native read phases, elapsed time, correlated operations, and safe failure classifications without recording raw exception text or sensitive content.
- Report inventory degradation and pagination progress using counts and continuation presence.
- Apply host level filtering: debug for routine activity, info for lifecycle, warn for degradation, and error for failures. Logging failures cannot change coordination outcomes or recursively generate events.
- Replace existing raw-error logging with safe classifications, intentionally excluding exception messages and stacks despite generic plugin guidance.
- Document log fields, verbosity, and retrieval supported by host documentation or source; explicitly state any unverified capture limitation.

## Privacy Boundary

Diagnostics use a closed allowlist: fixed events, operations and phases, fixed failure classifications with an unknown fallback, elapsed durations, counts, continuation-presence booleans, and independently generated diagnostic-only correlation IDs. They exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs, and content-derived hashes. Existing detailed user-facing registration errors remain unchanged. New cases in existing tests enforce this boundary with synthetic sentinels and preserve coordination outcomes when logging fails.

## Capabilities

### Modified Capabilities

- `worker-coordination`: an ADDED operational-diagnostics requirement preserves native inventory, connection safety, and coordination contracts.

## Impact

Runtime scope is `src/server.ts`, `src/tools.ts`, `src/native-connection.ts`, and `src/native-sessions.ts`; every existing server logging call migrates to the emitter. `package.json` declares the host-provided Effect peer and development pin; `bun.lock` follows. Supporting changes are `README.md`, existing native-connection/native-sessions/tools/worker-supervision tests, worker-coordination setup fixtures, `test/host.ts`, and these artifacts. No timeout, permission, tool-output, deployment-pin, or installed-vendor changes are included.
