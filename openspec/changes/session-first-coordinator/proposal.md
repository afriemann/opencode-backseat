# Proposal

## Why

Users want to coordinate OpenCode sessions through a conversation: list sessions across projects, take over an existing session, or create a session in a selected project and assign work. TUI attachment and automation prerequisites obstruct that workflow.

## What Changes

- Make native session discovery and truthful live status available to the coordinator independently of task bindings, storage authority, and TUI presence.
- Support explicit takeover and manual assignments without requiring observer attachment, resume, or automation arming.
- Create native sessions at the selected project and deliver the requested assignment through conversational control.
- Establish an automatic authenticated connection to the same service without manual endpoint or credential configuration; report an unsupported connection explicitly rather than substitute another service.
- Keep automation optional, preserve native permissions and durable delivery identities, and never silently retry an uncertain send.
- Distinguish manual sends in the existing delivery ledger without consuming automation allowances. Existing stores remain readable; older readers cannot read newly written manual-send records.
- Remove superseded paths rather than retaining deprecated aliases or duplicate native readers; breaking changes are acceptable.

## Capabilities

### Modified Capabilities

- `worker-coordination`: conversational session discovery, takeover, creation, and manual dispatch without TUI prerequisites.

## Impact

Server controls, RPC contracts, bundled coordinator instructions, shared native discovery/status reads, TUI read reuse, runtime client dependency, tests, and README. `src/state.ts` gains an additive manual-intent discriminator while preserving populated stores. No deployment, real-session mutation during verification, or service lifecycle changes.
