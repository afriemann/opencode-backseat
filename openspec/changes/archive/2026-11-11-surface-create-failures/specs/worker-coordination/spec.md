## ADDED Requirements

### Requirement: Actionable native failure reporting

The coordinator SHALL report a native operation failure with its specific cause category instead of a generic connection failure.

#### Scenario: Reports an unknown worker location or agent as a validation failure

- **WHEN** worker creation names a location that is not a native project or an agent not available there
- **THEN** the failure states that the selected worker location or agent is unavailable and no session is created.

#### Scenario: Names the failing error class without exposing its message

- **WHEN** a native operation fails with an unexpected error
- **THEN** the failure names the error class and excludes the error message, URLs and registration contents.
