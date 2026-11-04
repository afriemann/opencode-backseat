# Proposal

## Why

The user wants a more fitting, funny name for the parallel-session coordinator and selected Backseat. A complete rename avoids inconsistent product and API identities.

## What Changes

- **BREAKING**: replace current product, package, namespace, role, permission, RPC, plugin, command, internal and fixture identifiers with Backseat equivalents.
- **BREAKING**: use the renamed default data directory without aliases, old-store discovery, fallback or automatic migration; leave old data untouched. Explicit `dataDir` selection remains supported.
- Preserve coordination behavior, storage format, safety checks and the descriptive `/coordinate` command.

## Capabilities

### Modified Capabilities

- `worker-coordination`: expose the renamed coordinator and callable identity, and select the renamed default store.
- `coordination-tui`: present the renamed coordinator through native controls.
- `worker-supervision`: identify the product consistently without changing evaluation behavior.

## Impact

The approved 23-file inventory covers package metadata, runtime modules, existing tests, README, example configuration, Makefile, ignore rules and three current domain specs. Main specs change only through archive. Dependencies and persisted record schemas remain unchanged. Existing configurations and callers must use the new identifiers.

Native test fixtures resolve the installed host executable without changing their isolated environments.

GitHub repository renaming, checkout relocation, installed configuration changes and edits to archived history are excluded.
