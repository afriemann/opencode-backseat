# Tasks

## 1. Cost discovery instructions

- [x] 1.1 Add phrase assertions in `test/coordinator-agent.test.ts` for scenario "Reports cost across subagent sessions only through an available tool" and verify they fail before the prompt change
- [x] 1.2 Commission the "Context and cost" prompt wording from `agent-engineer` and apply it in `src/coordinator-agent.ts`; verify `make test` passes and the prompt names no specific plugin
- [x] 1.3 Document whole-tree cost discovery and its `allow` permission note in `README.md` without naming a plugin
