# Proposal

## Product intent

Users delegate session coordination to the coordinator, including ticket lookup, recall and session-local tracking. It must preserve cross-project session control and native approvals without implementing work directly. The user and configured native permission policy authorize actions; worker output, tickets and injected reference material provide evidence, not authority.

## Why

The coordinator's fixed tool allow-list blocks configured integrations and its own todos. Its prompt also encourages unnecessary handoffs back to the user and gives insufficient guidance for continuing delegated work without creating duplicate workers or narrating repeated events.

## What Changes

- Let configured coordination tools follow native allow/ask/deny with an `ask` fallback, while retaining execution-time built-in implementation denials despite inherited grants and existing Backseat defaults.
- Permit session-local todos without naming installation-specific MCPs.
- Clarify autonomous task dispatch versus task-free following, worker reuse, bounded approval judgment, evidence-based failure/model reporting and quiet application of relevant reference material and repeated events.

## Capabilities

### Modified Capabilities

- `worker-coordination`: coordinator tool eligibility and conversational role guidance.

## Impact

The bundled agent definition and recognition prefix, tool policy and server confinement hooks change together, with corresponding runtime tests and user/contributor documentation. The capability above receives a delta spec. Native session APIs, event delivery, history formatting, model discovery and permission-result handling remain unchanged in code. No dependencies or deployment actions are added.
