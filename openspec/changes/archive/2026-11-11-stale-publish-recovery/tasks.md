# Tasks

## 1. Storage recovery

- [x] 1.1 Remove safe stale `.publish-<uuid>` files when opening a writable store (scenarios "Recovers from an interrupted publication", "Holds on an unexpected store entry")
- [x] 1.2 Unlink the temporary file when `publish` fails
- [x] 1.3 Replace the "interrupted" case in "Holds unsafe or corrupt shared storage" test with the two new scenario tests

## 2. Held coordinator

- [x] 2.1 Retry acquisition from a held core on each storage-backed call and start the event observer on promotion (scenario "Recovers a held coordinator once storage is safe")

## 3. Diagnostics

- [x] 3.1 Carry the sanitized storage failure classification into `setup.degraded` in `src/server.ts`
