# Tasks

## 1. Project directory discovery

- [x] 1.1 Add `worktree.list` to `NativeCatalogClient` and extend `NativeDiscovery.projects()` to include each project's host-reported directories, read in batches of `NATIVE_BOUNDS.concurrentReads`; verify the "Lists a project's additional directories" and "Fails explicitly when project directories cannot be read" tests pass
- [x] 1.2 Add `worktree.list` to the client fakes in `test/tools.test.ts` and `test/session-control.test.ts`; verify `make test` passes

## 2. Gate closure instruction

- [x] 2.1 Add the close-gate-before-sending rule to the "Controlling sessions" section of the coordinator prompt; verify the "Closes a pending gate before sending other input" test passes

## 3. Content page bounds

- [x] 3.1 Raise `CONTENT_BOUNDS.pageBytes` to 1,048,576 and both default `maxBytes` values to 128,000 in `src/native-content.ts`, and update reader descriptions; verify the "Returns large default pages" test and the updated bound test pass

## 4. Verification

- [x] 4.1 Run `make check` and verify it passes
