# Tasks

## 1. Visible model-facing text

- [x] 1.1 Add a fixed notification description in `src/server.ts`; verify the "Shows each notification in the coordinator transcript" test passes
- [x] 1.2 Require a non-blank `description` for `synthetic` in `src/native-operations.ts`, its tool description and the coordinator prompt; verify the "Requires a visible description on inserted synthetic text" test passes

## 2. Idle trigger and context hook

- [x] 2.1 Match `session.execution.succeeded` instead of `session.idle`; verify the "Notifies when a followed worker finishes a turn" test passes
- [x] 2.2 Latch successful role decisions per session in the `context` hook (design decision 1); verify one lookup across repeated calls and that an error is not latched

## 3. Logging

- [x] 3.1 Add the new `DIAGNOSTIC_EVENTS` labels and thread an optional emitter through `SessionControllerHost` and the follower; remove `admissionDiagnostic`; verify no `process.stderr.write` remains in `src/server.ts`
- [x] 3.2 Emit `setup.configured` with version labels and set option names, and diagnostics before the `execute.before` throw and on `context` tool removal; verify the "Reports resolved configuration without option values" test passes

## 4. Documentation

- [x] 4.1 Document in `README.md` the Code-Mode-only tools, the coordinator tool-catalog restriction, visible model-initiated instruction entries, the `location` meaning and the `@opencode/plugin/promise/adapter` import; document the Bun and `make coverage` CI shape in `AGENTS.md`; verify `make hooks` passes
