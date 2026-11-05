# opencode-backseat

An OpenCode plugin that lets one conversation coordinate parallel OpenCode sessions: read and control native sessions across projects, create or adopt workers, and optionally supervise workers with automatic follow-ups. Everything is driven through the coordinator agent; there is no terminal UI. Mutating session and control operations (create, adopt, send, permission and form replies, delete, supervision start, resume and recovery) require operation-bound native approval. It targets the OpenCode V2 plugin runtime (`@opencode/plugin`); setup refuses hosts older than 2.2.5. `README.md` is the user guide; this file is for contributors.

## How it fits together

- **Server plugin** (`src/server.ts`, package export `.`): `setup` registers the bundled coordinator agent, the permission and tool hooks that confine it, the `backseat.*` Code Mode tools, and the retained native identity RPC handlers. It also owns the native backend (`createNativeBackend`).
- **Coordinator agent** (`src/coordinator-agent.ts`): the `backseat-coordinator` primary agent. Its system prompt, permission rules and definition recognition are defined here; the tool allow-list (`COORDINATOR_TOOL_IDS`) is in `src/tools.ts`, and the hooks in `server.ts` enforce it.
- **Tools** (`src/tools.ts`): the discoverable coordination tools. `src/native-operations.ts` holds the typed native session-control operations, approval resources and send preparation; `src/native-content.ts` holds the bounded history readers and since-send tracking with their continuation handles. Discovery is in `src/native-sessions.ts`; the connection to the host's native service is in `src/native-connection.ts`, which also defines the structured diagnostics.
- **Supervision** (`src/supervision.ts`, `src/lifecycle.ts`, `src/evaluator.ts`, `src/dispatch.ts`, `src/context.ts`): `supervision.ts` is the server-owned runtime started, held, resumed and recovered through the coordinator; the rest decide whether a settled worker needs a follow-up, build the task-scoped evaluation input, and deliver follow-ups.
- **Identity RPC** (`src/rpc.ts`, export `./rpc`): the authenticated native identity and shared-state contract the server keeps for its own integrations.
- **State and ownership** (`src/state.ts`, `src/storage.ts`, `src/ownership.ts`): the shared task and session-delivery store, its bounds and parsing, data-directory safety checks, and single-coordinator ownership through `/usr/bin/flock`.

Behavioural requirements live in `openspec/specs/<capability>/spec.md`. Read the matching spec before changing behaviour:

| Capability            | Covers                                                     |
| --------------------- | ---------------------------------------------------------- |
| `worker-coordination` | Session content and control, adoption, deletion, ownership |
| `worker-supervision`  | Settled-work evaluation and automatic follow-ups           |
| `task-context`        | Task-scoped evaluation inputs and shared snapshots         |

Tests in `test/*.test.ts` group their `describe` blocks by spec requirement. `test/host.ts` is the shared fake-host harness.

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
- Add or update tests with every behaviour change; keep `make check` green before opening a pull request.
- Branch from `main` as `type/short-slug` (`feat/`, `fix/`, `docs/`, `refactor/`, `ci/`) and use Conventional Commits; gitlint enforces the format. Mark breaking changes with `!`.
- Keep user-facing explanation in `README.md` and requirement detail in the specs; do not duplicate either here.
- Never commit state directories (`.opencode/backseat/`) or secrets; detect-secrets runs as a hook against `.secrets.baseline`.
- Code and comments describe the current behaviour only; history lives in git and in archived OpenSpec changes.
