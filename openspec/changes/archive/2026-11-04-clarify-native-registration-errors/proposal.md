# Proposal

## Why

Ordinary group-writable home and XDG directories prevent native inventory and shared coordination from working. Requiring users to change permissions throughout their directory hierarchy is not an acceptable setup requirement.

## What Changes

- Accept group-writable ancestry for native registration and shared storage under an explicit trusted-group policy, and accept qualifying root/user-owned sticky parents.
- Keep private storage and registration files, ownership and replacement checks, locking, and connection confinement; reject non-sticky publicly writable ancestors.
- Explain retained native-directory rejections without automatic permission changes.
- Document that group-authorized ancestor writers can disrupt or restore subtrees; this policy does not provide equivalent protection against such writers.

## Capabilities

### Modified Capabilities

- `worker-coordination`: support ordinary writable ancestry for automatic native connections and shared durable coordination storage.

## Impact

Implementation touches `src/native-connection.ts` and `src/storage.ts`, with regression coverage in `test/native-connection.test.ts` and `test/worker-coordination.test.ts` and trust-boundary documentation in `README.md`. No dependency, location, state-format, configuration, or tool-schema changes are needed. Shared-storage error categorization and native-client replacement are out of scope.
