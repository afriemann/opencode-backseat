# Spec Delta

## MODIFIED Requirements

### Requirement: Native-default background evaluation

The coordinator SHALL use OpenCode's resolved default model for the initiating coordinator's actual project when performing background task evaluation.

#### Scenario: Uses the coordinator-project native default

- **GIVEN** a verified coordinator session and a native default model available at its actual project
- **WHEN** a background suggestion or bounded validation is requested
- **THEN** generation explicitly uses that resolved model with only the task-scoped evaluation input.
- **AND** the conversation's selected model remains unchanged; no Backseat model setting, worker-project model, title-agent model or data-directory configuration substitutes for that default.

#### Scenario: Holds unavailable default-model evaluation

- **WHEN** native model resolution fails, returns no model or a mismatched project, or generation fails
- **THEN** evaluation remains visibly held or unavailable without a follow-up or completion record, a guessed model fallback or an automatic retry.
