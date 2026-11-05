# opencode-backseat

An OpenCode plugin that lets one conversation coordinate parallel OpenCode sessions: list sessions across projects, create or adopt workers, assign work, and optionally supervise workers with automatic follow-ups. Consequential session and control operations (create, adopt, assign, delete, observer changes) require operation-bound native approval. It targets the OpenCode V2 plugin runtime (`@opencode/plugin`); setup refuses hosts older than 2.2.5. `README.md` is the user guide; this file is for contributors.

## How it fits together

- **Server plugin** (`src/server.ts`, package export `.`): `setup` registers the bundled coordinator agent, the permission and tool hooks that confine it, the `backseat.*` Code Mode tools, and the RPC handlers the TUI calls. It also owns the native backend (`createNativeBackend`) that creates, adopts and deletes sessions.
- **Coordinator agent** (`src/coordinator-agent.ts`): the `backseat-coordinator` primary agent. Its system prompt and permission rules are defined here; the tool allow-list (`COORDINATOR_TOOL_IDS`) is in `src/tools.ts`, and the hooks in `server.ts` enforce it.
- **Tools** (`src/tools.ts`): the coordination tools exposed to the coordinator. Discovery is in `src/native-sessions.ts`; the connection to the host's native service is in `src/native-connection.ts`, which also defines the structured diagnostics.
- **Optional TUI** (`src/tui.ts`, export `./tui`, with `src/ui.ts` for dialog content): the `/coordinate` controls. It observes workers and calls back into the server over the typed RPC contract in `src/rpc.ts` (export `./rpc`).
- **Supervision** (`src/lifecycle.ts`, `src/evaluator.ts`, `src/dispatch.ts`, `src/context.ts`): decides whether a settled worker needs a follow-up, builds the task-scoped evaluation input, and delivers follow-ups.
- **State and ownership** (`src/state.ts`, `src/storage.ts`, `src/ownership.ts`): the shared task store, its bounds and parsing, data-directory safety checks, and single-coordinator ownership through `/usr/bin/flock`.

Behavioural requirements live in `openspec/specs/<capability>/spec.md`. Read the matching spec before changing behaviour:

| Capability            | Covers                                                  |
| --------------------- | ------------------------------------------------------- |
| `worker-coordination` | Task binding, adoption, assignment, deletion, ownership |
| `worker-supervision`  | Settled-work evaluation and automatic follow-ups        |
| `task-context`        | Task-scoped evaluation inputs and shared snapshots      |
| `coordination-tui`    | Terminal selectors, overview and status                 |

Tests in `test/*.test.ts` group their `describe` blocks by spec requirement. `test/host.ts` is the shared fake-host harness, and `test/goldens/` holds plain-text dialog inventories (not renderer captures).

## Development

Requirements: Linux, Bun 1.4.4 (what CI uses), Node >=22.5, and an executable `/usr/bin/flock`. `make prerequisites` checks the platform and helper.

```sh
make install
make test          # narrow with TEST_PATH=./test/tools.test.ts
make typecheck
make lint
make hooks         # prettier, eslint, typecheck, gitlint, detect-secrets
make check         # prerequisites, test, typecheck, lint, hooks
make native-test   # needs the installed OpenCode host
```

`make help` lists every target. Run `make hooks-install` once per clone. CI runs `make prerequisites`, `make coverage` and `make hooks` on pull requests and on pushes to `main`, and needs `/tmp/opencode` to exist.

To try the plugin in a real host, point a project's `opencode.json(c)` at this checkout using `examples/opencode.jsonc`. `make test` and `make check` never touch a running OpenCode service.

## Contributing

- Behaviour changes follow an approved OpenSpec change under `openspec/changes/<name>/`; archive it in a separate `docs:` commit. Documentation-only changes need no OpenSpec change.
- Add or update tests with every behaviour change; keep `make check` green before opening a pull request. Update `test/goldens/` when dialog content changes intentionally.
- Branch from `main` as `type/short-slug` (`feat/`, `fix/`, `docs/`, `refactor/`, `ci/`) and use Conventional Commits; gitlint enforces the format. Mark breaking changes with `!`.
- Keep user-facing explanation in `README.md` and requirement detail in the specs; do not duplicate either here.
- Never commit state directories (`.opencode/backseat/`) or secrets; detect-secrets runs as a hook against `.secrets.baseline`.
- Code and comments describe the current behaviour only; history lives in git and in archived OpenSpec changes.
