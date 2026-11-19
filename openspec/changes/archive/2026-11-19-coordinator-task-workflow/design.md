# Design

## Data sources for `read_session_usage`

- `client.session.get`: `cost`, `tokens` (input, output, reasoning, cache read/write) are required on `SessionInfo`; `model` (`{id, providerID, variant?}`) and `revert` are optional. A missing model yields `unknown`.
- `client.model.list({location})`: `ModelInfo.limit.context` is a required integer. Join on `providerID` and `modelID` (not `id`) against the session model; no match yields an `unknown` limit. `NativeDiscovery.models` drops the limit, so it gains a sibling lookup rather than widening `ModelChoice`.
- `client.message.list({sessionID, order: "desc", limit})`, no type filter: the first `assistant` item is the newest. Its `tokens` and `time.completed` are optional. A `compaction` item newer than it means unknown. A page with no assistant message yields unknown; there is no paging past the first page.
- `session.revert` present yields unknown.

## Estimate

Estimate = newest assistant `input + cache.read + cache.write + output`: the prompt that message sent plus what it added, the closest proxy for the next prompt. Cumulative totals would overstate it, since they re-count every turn. Reasoning is excluded because it is not necessarily retained in context. Whether `output` already includes reasoning is unverified; the estimate is labelled approximate.

## Output naming

Separate groups: `cumulative: {cost, tokens}`, `model`, `contextLimit`, `contextEstimate: {tokens, basis}`. Each leaf is a number or the string `unknown`.

## Placement

A `read_session_usage` entry in `CONTENT_READERS` with kind `usage`, built by the shared `reader` helper, so it has the same `sessionID`, `location` and `agent` schema. The existing loop in `tools.ts` supplies canonical-location checking and `native()` permission assertion. A new `usage` case in the `read` handler switch reuses the target check before and after the read. Responses are small, so no cursor. Children are excluded by reading only the given session.

## Permission list

An explicit `backseat_read_session_usage` allow is appended after the final entry. The coordinator `isCoordinator` matcher compares by prefix with `actual.length >= expected.length`, so only copies of the previous, shorter definition stop being recognised.

## System prompt

The prompt is one constant in `coordinator-agent.ts` and is compared by exact equality, so any wording change makes older copies unrecognised. `agent-engineer` authors the workflow text; the engineer wires the constant and the rule.
