## 1. Usage tool

- [x] 1.1 Add the `read_session_usage` reader and `usage` handler case in `src/native-content.ts` (scenarios: Reports usage for a session, Rejects an unavailable session)
- [x] 1.2 Add the model context-limit lookup in `src/native-sessions.ts`
- [x] 1.3 Derive the context estimate and `unknown` cases (scenarios: Reports undeterminable values as unknown, Reports unknown context size when the newest usage is stale)

## 2. Coordinator definition

- [x] 2.1 Append the `backseat_read_session_usage` allow entry in `src/coordinator-agent.ts` (scenario: Allows usage reading by default)
- [x] 2.2 Commission the workflow system prompt from `agent-engineer` and wire it as the prompt constant (scenarios under Coordinator task workflow)

## 3. Tests

- [x] 3.1 Cover each scenario of "Session usage reading" in `test/tools.test.ts`
- [x] 3.2 Cover the prompt key phrases and permission entry in `test/coordinator-agent.test.ts`

## 4. Documentation

- [x] 4.1 Document the workflow and `read_session_usage` in `README.md`
