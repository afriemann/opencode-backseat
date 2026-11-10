## 1. Tests and implementation

- [x] 1.1 Encode "Updates a session whose location or agent is gone" and "Deletes a session whose location or agent is gone" as failing tests in `test/session-control.test.ts`
- [x] 1.2 Tolerate a missing location and an absent agent for update and delete targets in `src/server.ts`; make `agent` optional for `update_session` in `src/tools.ts` and `src/native-operations.ts`; allow an absent agent in `src/state.ts` delivery records
