# Design

## Context

Store authority, manual control and approved supervision are separate gates. The shared core serializes participants; existing startup loading fences active bindings and retains delivery uncertainty.

## Decisions

- Make startup acquisition authoritative inside the ownership port. Acquire the exclusive kernel guard, reread the owner record and prove termination using the existing boot, PID-namespace and process-start identity checks. Replace a terminated owner's record directly under that retained guard and retain it as the new lease. Update native-core storage authority only after successful acquisition; load and durably fence state before exposing manual mutations. This keeps ownership replacement and writable storage admission in one exclusion chain.
- Preserve startup loading's active-binding epoch increments, reserved-intent conversion to ambiguous, delivery identities and consumed counters. Loading or publication failure leaves the runtime held. Storage ownership never attaches a supervision generation; rearming retains its separate approved reconciliation path.
- Return discriminated ownership outcomes with fixed categories: live-owner, unverifiable-owner, unsafe-storage and host-capability-unavailable. Distinguish unreadable state/publication failure at the backend. Treat lock contention as a live-holder blocker without trusting an unlocked record. Unknown process evidence stays unverifiable. Fixed messages avoid exception leakage and misleading recovery advice.
- Branch adoption on actual task-field absence before task parsing. Supplied malformed or null tasks fail validation; explicit tasks retain the existing binding path. Resolve task-free targets from native metadata, snapshot identity/location/agent/ancestry, and revalidate after separate adoption approval under the shared mutation queue.
- Consult authoritative bindings, never infer absence from failed reads. An unbound target returns accepted with its session identity and an explicit unbound outcome, without durable registration. An active, held or manual binding uses existing takeover fencing; a completed binding is rejected consistently with takeover. Approval binds the selected target and existing binding revision/epoch when present. This reuses current ownership semantics without another ledger.

## Risks / Trade-offs

- Process identity cannot prove termination across boot or namespace changes: remain held rather than broaden recovery assumptions.
- Task-free acceptance grants no durable exclusive ownership: later operations independently validate authority, target and delivery state.
