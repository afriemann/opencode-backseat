# Spec Delta

## REMOVED Requirements

### Requirement: Settled-work supervision

**Reason**: Coordinator conversations react to followed-session events rather than evaluator snapshots.
**Migration**: Adopt the selected session to follow its native events.

### Requirement: Prompt-only automatic action

**Reason**: The coordinator uses native controls and judgment, including request replies.
**Migration**: Give instructions to the following coordinator.

### Requirement: Durable automation bounds

**Reason**: Task-based evaluator budgets are removed with task automation.
**Migration**: Following uses bounded event transport, not task follow-up allowances.

### Requirement: Current decision binding

**Reason**: No separate evaluator decision or supervision generation remains.
**Migration**: Inspect current native session state and use typed controls.

### Requirement: Reconciled prompt admission

**Reason**: Uncertain native deliveries are covered by worker-coordination rather than automatic dispatch.
**Migration**: Use session-native send reconciliation.

### Requirement: Evidence-based completion

**Reason**: The plugin no longer stores task completion decisions.
**Migration**: The coordinator assesses progress from native content.

### Requirement: Connected supervision recovery

**Reason**: Following recovers without supervision rearming.
**Migration**: Saved followers resume event replay automatically.

### Requirement: Native-default background evaluation

**Reason**: The separate background evaluator is removed.
**Migration**: Event notifications wake the existing coordinator conversation using its selected model.
