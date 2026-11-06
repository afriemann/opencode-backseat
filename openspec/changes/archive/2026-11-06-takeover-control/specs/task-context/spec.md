# Spec Delta

## REMOVED Requirements

### Requirement: Task-scoped evaluation inputs

**Reason**: No task evaluator remains.
**Migration**: Inspect selected native session content from the coordinator.

### Requirement: Explicit versioned sharing

**Reason**: Task snapshots and recipient task bindings are removed.
**Migration**: Give relevant instructions directly to the coordinator or selected native session.

### Requirement: Evidence has no control authority

**Reason**: Task-specific evidence and snapshot authority are removed.
**Migration**: Worker-coordination retains the distinction between worker evidence and user instructions while allowing coordinator judgment.
