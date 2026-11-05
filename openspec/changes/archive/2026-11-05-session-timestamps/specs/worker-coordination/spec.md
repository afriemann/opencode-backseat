## ADDED Requirements

### Requirement: Native session inventory timestamps

The coordinator SHALL include numeric `createdAt` and `updatedAt` fields in each `list_sessions` row, copied from native `time.created` and `time.updated` as Unix milliseconds. `updatedAt` represents general session-update recency, not exclusively conversation activity.

#### Scenario: Returns native session timestamps

- **GIVEN** native sessions with distinct creation and update timestamps
- **WHEN** the coordinator lists sessions or follows a buffered continuation
- **THEN** each row exposes those timestamps unchanged, using refreshed detail metadata when available.

#### Scenario: Preserves timestamps when status refresh is unavailable

- **GIVEN** native list metadata with creation and update timestamps
- **WHEN** a session detail read fails and the caller includes unknown status
- **THEN** the row retains the available list timestamps with unknown status and partial inventory.
