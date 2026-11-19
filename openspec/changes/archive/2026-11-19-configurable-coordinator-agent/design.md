# Design

## Decisions

### Instance-bound coordinator

`coordinator-agent.ts` exports `createCoordinator(options)`, returning `{ definition, isCoordinator }`, or a validation failure naming the option. `definition.id` and `.name` are the configured values; `isCoordinator(agent)` compares against that instance's definition. The module-level `coordinatorAgent` constant, `COORDINATOR_AGENT_ID` and the exported `isCoordinatorAgent` are removed.

Option parsing and validation live in `coordinator-agent.ts` beside the definition they configure, not in `storage.ts`, which owns data-directory settings only. `ctx.options` is read once in `setup`. The instance replaces the constant in `agent.transform`, `matchesExecutionRole`, the `context` hook, `authorize` and its "select the coordinator" message. `NativeSessions` receives `isCoordinator` and the configured id by construction for `list_agents` exclusion and `isCoordinator(location, agentID)`.

The system prompt names the role, not the identifier, so the shared prompt stays identical across instances.

### Invalid options

Validation runs before registration. A failure emits `setup.degraded` with `classification: "validation"` and an `option` label (`agentID` or `agentName`), never its value; the host diagnostic projection allowlists that field. Setup does not abort: the `agent.transform` registration is skipped, and `matchesExecutionRole` returns false without lookups. The tool registry, RPC, storage and following still register; with no coordinator registered, `authorize` rejects every `backseat.*` call, so the diagnostic is the user's cue.

### Collision

Inside the transform, an existing `editor.get(id)` means another definition holds the identifier, because this plugin has not yet registered it. The transform returns without updating (user definition preserved, `agentName` ignored) and emits the same diagnostic with `option: "agentID"`, once per setup since the callback may rerun. The identifier itself is not logged: the privacy allowlist admits fixed labels only.

### Recognition

`isCoordinator` compares id, mode, hidden, system and the permission prefix, never the name. The name is cosmetic and user-editable.

## Verified host facts

- `Agent.select` (`packages/core/src/agent.ts`) returns `info: undefined` for an unregistered stored id. `SessionContext.select` then fails with `AgentNotFoundError`. A session on the old `backseat-coordinator` id therefore errors at its next run and is not a coordinator for Backseat.
- Host built-in ids set in `packages/core/src/plugin/agent.ts`: `build`, `general`, `explore`, `compaction`, `title`, `summary`. The default id `backseat` collides with none. A configured `agentID` can, so the collision path above covers it.
