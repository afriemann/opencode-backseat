# Spec Delta

## ADDED Requirements

### Requirement: Native-default background evaluation

The coordinator SHALL use OpenCode's resolved default model for the initiating coordinator's actual project when performing background task evaluation.

#### Scenario: Uses the coordinator-project native default

- **GIVEN** a verified coordinator session and a native default model available at its actual project
- **WHEN** a background suggestion or bounded validation is requested
- **THEN** generation explicitly uses that resolved model with only the task-scoped evaluation input.
- **AND** the conversation's selected model remains unchanged; no Conman model setting, worker-project model, title-agent model or data-directory configuration substitutes for that default.

#### Scenario: Holds unavailable default-model evaluation

- **WHEN** native model resolution fails, returns no model or a mismatched project, or generation fails
- **THEN** evaluation remains visibly held or unavailable without a follow-up or completion record, a guessed model fallback or an automatic retry.

## MODIFIED Requirements

### Requirement: Durable automation bounds

The coordinator SHALL enforce finite worker, shared reasoning-capacity, retained-record, byte, follow-up, decision-age and nonprogress limits across turns and reloads.

#### Scenario: Exhaustion holds the task

- **GIVEN** defaults of eight active workers, three automatic follow-ups per task, twenty-minute decision expiry and two consecutive nonprogress decisions
- **WHEN** an action would exceed an applicable limit
- **THEN** it is rejected or visibly held before exceeding the limit; suggestion and validation share bounded capacity and require current observer possession, while retained evidence and unresolved identities are not silently pruned.

#### Scenario: Reload preserves consumed limits

- **GIVEN** a task has consumed its automatic follow-up allowance
- **WHEN** the plugin reloads and the user explicitly rearms coordination
- **THEN** that allowance remains consumed and no additional follow-up is admitted unless the user explicitly authorises a new finite limit.
- **AND** changing the coordinator's project while using the same store does not reset consumed limits or discard uncertain delivery identities; obsolete decisions remain ineligible, and fresh approval and native reconciliation are still required.
