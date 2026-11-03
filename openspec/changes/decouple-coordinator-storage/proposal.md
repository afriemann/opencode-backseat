# Proposal

## Why

Users should coordinate work from their current project, not navigate to a storage directory. Conversation location, durable coordination state and worker project locations are independent concerns.

## What Changes

- Make the bundled coordinator and its restricted tools available wherever the plugin is enabled.
- Store shared coordination data and its ownership lock in a user data directory, defaulting to `$XDG_DATA_HOME/opencode-conman` or `~/.local/share/opencode-conman`, with an optional explicit `dataDir`.
- Give enabled projects one coherent shared authority and state view while preserving single-owner enforcement, operation-bound approval, task isolation, evidence provenance and separately armed connected-TUI supervision.
- Keep full coordination-state access behind verified coordinator or approved-TUI authority rather than exposing unrelated task data through project bootstrap.
- Reuse OpenCode's resolved default model for background evaluations while conversational coordination retains its selected model; add no duplicate model configuration or title-model dependency.
- **BREAKING:** remove required `home` configuration, storage-directory session restrictions and location-bound authority identity. Start fresh in the new store without legacy fallback, migration or deletion of existing state.

## Capabilities

### Modified Capabilities

- `worker-coordination`: shared storage authority and dedicated-role coordination independent of conversation directory.
- `coordination-tui`: native coordinator entry and state inspection from any enabled project.
- `worker-supervision`: shared durable automation bounds and native-default background model selection.

## Impact

New storage module; server registration, persistence and routing; ownership locks; TUI eligibility; RPC/state identities; existing tests; README and example configuration. Task-context isolation remains unchanged.

Work is local only. Publication, global configuration edits, state migration or deletion, live worker activation and automatic attachment or arming are excluded.
