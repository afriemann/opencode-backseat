## Decisions

- Use one ancestor policy in `src/native-connection.ts` and `src/storage.ts`: accept real directories owned by root or the current UID; allow group-write; allow other-write only with the sticky bit. Sticky acceptance depends on the same trusted ownership checks for immediate child entries. Keep symlink rejection and device/inode comparisons. This bounded policy accommodates ordinary home/XDG layouts without effective-access discovery.

- Validate sticky edges within the existing traversals. Registration checks directory children during its leaf-to-root walk; the registration file's current-UID check completes the immediate parent/file edge before opening contents. Storage validates each opened child through its existing per-component validation before advancing or using the final directory. Do not waive child ownership while traversing a sticky parent. Apply the same ancestor predicate and child-owner checks during registration post-read validation and every storage revalidation.

- Preserve leaf checks exactly: the final storage directory is current-UID-owned with permission bits `0700`; storage and lock files are current-UID-owned regular single-link files with bits `0600`. Registration remains a current-UID-owned regular single-link file with no group/other permission bits, retaining its size and replacement checks. Ancestor relaxation does not apply to private leaves; do not repair permissions automatically.

- Reuse storage's existing `check()` choke point. Use a file-local predicate for repeated registration checks if useful; introduce no shared helper module, membership lookup, ACL interpreter or configuration switch. Keep trusted executable-path checks in `ownership.ts` untouched.

- Keep native connection architecture, authentication, instance verification, confinement, cancellation, fd-relative storage, locks, publication, formats and locations unchanged. Prefer local predicate changes over relocation or native-client replacement: relocation risks split state and cannot fix host registration discovery; context interfaces do not provide the complete inventory bundle.

- Retain fail-fast native diagnostics for type, ownership and non-sticky other-write rejection, with quoted paths and relevant UID/mode details. Never classify group-write alone as unsafe. Keep post-read change diagnostics and shared-storage error categorization unchanged.

- Trust group/ACL-authorized ancestor writers explicitly, without claiming their absence. Such writers can disrupt or restore subtrees, undermining rollback resistance and lock continuity; private leaves and sampled inode checks do not eliminate that accepted limitation.
