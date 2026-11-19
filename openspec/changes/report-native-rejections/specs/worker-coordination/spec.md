## MODIFIED Requirements

### Requirement: Actionable native failure reporting

The coordinator SHALL report a native operation failure with its specific cause category instead of a generic connection failure.

#### Scenario: Reports an unknown worker location or agent as a validation failure

- **WHEN** worker creation names a location that is not a native project or an agent not available there
- **THEN** the failure states that the selected worker location or agent is unavailable and no session is created.

#### Scenario: Names the failing error class without exposing its message

- **WHEN** a native operation fails with an unexpected error
- **THEN** the failure names the error class and excludes the error message, URLs and registration contents.

#### Scenario: Reports a typed host rejection as a rejection

- **WHEN** the verified native service rejects a requested operation with a typed error, such as a permission request that no longer exists
- **THEN** the failure states that the native service rejected the request, names the error class, and does not describe the connection as unavailable or unsupported.
