# Guided startup

## ADDED Requirements

### Requirement: Guided coordinator startup

The terminal interface SHALL offer a keyboard-reachable guided startup flow without requiring a user prompt to establish a coordinator session.

#### Scenario: Starts from a blank coordinator without a prompt

- **GIVEN** coordination is unattached and the user opens the overview or startup palette entry
- **WHEN** the user explicitly chooses to use a valid current coordinator or create a blank coordinator at the canonical home
- **THEN** the interface opens and verifies that unarchived nonworker session before requesting native attachment approval, without a model call, user prompt or worker creation.
- **AND** HOME, archived, bound-worker and wrong-location sessions are not repurposed; ordinary overview inspection creates nothing.
- **AND** the canonical home can be inspected through read-only native details before creation, and the empty worker inventory remains visible.

#### Scenario: Keeps approval and arming separate

- **WHEN** the user cancels startup, denies attachment, or chooses Not now after confirmed attachment
- **THEN** supervision remains stopped and the interface accurately distinguishes unattached from connected-but-stopped state, retaining any confirmed session and attachment.
- **AND** only a separate Start supervision choice invokes current reconciliation and rearm; failed reads, approval, navigation or rearm never report readiness.

#### Scenario: Reuses confirmed sessions after interrupted startup

- **GIVEN** startup has created a coordinator or this runtime already has a current approved attachment
- **WHEN** the user explicitly resumes startup
- **THEN** the interface revalidates and reuses the confirmed session or attachment instead of duplicating creation or approval.
- **AND** queued activation prevents duplicate in-flight creation; an unknown creation outcome prevents automatic retry and reports how to select the resulting session, while stale attachment or reconnect requires fresh approval.
