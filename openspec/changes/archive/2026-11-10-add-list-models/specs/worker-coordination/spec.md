## ADDED Requirements

### Requirement: Native model discovery

The plugin SHALL provide a coordinator tool that lists the enabled native models available at an absolute canonical location, giving each model's providerID, id, name, status and variant IDs in the form accepted by `switch_session_model`.

#### Scenario: Lists enabled models with variants

- **WHEN** the coordinator lists models at a location returned by list_projects
- **THEN** each enabled model is returned with providerID, id, name, status and variants, and disabled models are omitted.

#### Scenario: Rejects a mismatched location

- **WHEN** the native model list reports a different location than requested or exceeds the catalog bound
- **THEN** the tool fails instead of returning a partial or mismatched list.
