## 1. Content reads

- [x] 1.1 Default export to unredacted and normalise sanitize in the query fingerprint (Exports unredacted content by default)
- [x] 1.2 Serve chunks from a per-handle snapshot with sliding one-hour TTL, LRU eviction and a 256 MiB budget (Reads content larger than eight megabytes in consistent chunks, Reports snapshot capacity exhaustion)
- [x] 1.3 Update tool descriptions and the five-minute text for the new defaults

## 2. Control

- [x] 2.1 Allow archived sessions in `SessionController.target` and reconciliation, keeping `matchesExecutionRole` (Controls an archived session, Adopts an archived session)
- [x] 2.2 Reject coordinator agents on create, switch agent and import; allow all others (Uses any non-coordinator native agent)
- [x] 2.3 Replace string and array caps with one 32 MiB payload bound (Accepts long sends and payloads)

## 3. Discovery and following

- [x] 3.1 Remove the 200-row failure checks on unpaged lists and page worker discovery (Lists catalogs beyond two hundred rows)
- [x] 3.2 Reconciliation scans the full history, stops at the match, drops the seen-set
- [x] 3.3 Raise the follower count per design

## 4. Docs

- [x] 4.1 Update README for unredacted export and new limits
