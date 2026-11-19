# Tasks

## 1. Deadline

- [x] 1.1 Let `NativeConnection.read` take an operation timeout that replaces the shared deadline once the handshake completes, forward it through the controller host in `src/server.ts`, and verify the connection tests pass
- [x] 1.2 Mark `recap_session` and `generate_session` with a 120-second timeout in `src/native-operations.ts` and pass it on execute, verifying "Recaps a session whose generation outlasts the default read deadline" and "Reports a timeout when generation exceeds the recap deadline" pass
- [x] 1.3 Note the longer recap limit in `README.md`
