# Design

## Decisions

**D1. One policy predicate replaces `COORDINATOR_TOOL_IDS`.**
`src/tools.ts` exports `isCoordinatorToolPermitted(id)`, used by the `context` catalog filter and the `execute.before` guard in `server.ts`. Both hooks call the same function, so they cannot drift. The host invokes `execute.before` for every tool nested in Code Mode as well as direct calls, so one predicate covers both paths.
Rejected: a separate list per hook (drift); a user-configurable deny list (YAGNI, weakens the guarantee).

**D2. Native policy passthrough; the hooks only remove.**
Order: (1) implementation denials, (2) existing Backseat/execute/question allows plus exact `todowrite` and `todoread`, (3) every other tool stays eligible and is decided by native allow/ask/deny. The agent rule list becomes `* ask`, explicit denies, then the existing allows. The hooks never grant. An inherited allow cannot re-open a denied tool because the hooks deny independently of rules.
Boundary: the host asserts a permission for every MCP call before invocation, so MCP tools get native checks. Custom plugin tools are responsible for their own checks. Backseat adds no universal guard, by the user's choice; this boundary is stated in the README and contributor docs.
Rejected: a Backseat-side universal assert (duplicates host policy, cannot know each tool's resources).

**D3. Denials: exact built-in IDs and two prefixes, case-sensitive.**
Exact: `shell`, `bash`, `edit`, `write`, `patch`, `read`, `glob`, `grep`, `webfetch`, `subagent`, `skill`. Prefixes: `lsp_`, `use_`. Host IDs are exact registered names, so no normalisation; case-insensitive matching could wrongly restrict differently cased integration IDs. No MCP namespaces and no websearch are named unless the user approves them.
Todos are configured plugin tools, not host core tools, so both are allowed by exact ID only if present.
Rejected: regex or glob rules (harder to audit, may catch legitimate integrations).

**D4. Definition recognition keeps its structure.**
`isCoordinatorAgent` still compares the leading permission rules, system prompt, mode and hidden flag. It follows the new rule list and the final prompt text, which `agent-engineer` authors.

## Impact

Configured integrations become reachable but default to `ask`, so first use prompts the user. No existing capability is removed.
