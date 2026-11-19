## 1. Option parsing and coordinator instance

- [x] 1.1 Add `createCoordinator(options)` with option validation in `src/coordinator-agent.ts`; remove the module constant, `COORDINATOR_AGENT_ID` and `isCoordinatorAgent` (scenarios: Uses default identifier and name, Rejects invalid coordinator options)
- [x] 1.2 Bind registration, role matching, context hook, authorize and its message in `src/server.ts` to the instance; emit validation and collision diagnostics (scenarios: Registers a configured identifier and name, Preserves a configured coordinator agent)
- [x] 1.3 Pass the instance to `NativeDiscovery` in `src/native-sessions.ts` for agent listing and worker rejection

## 2. Tests

- [x] 2.1 Migrate `test/coordinator-agent.test.ts`, `test/runtime.test.ts`, `test/session-control.test.ts` and `test/tools.test.ts` to the instance and new default id
- [x] 2.2 Cover each new and changed scenario of "Bundled conversational coordinator"

## 3. Documentation

- [x] 3.1 Update `README.md` (title, setup step, option table, rename consequence), `AGENTS.md` and `examples/opencode.jsonc`
