## MODIFIED Requirements

### Requirement: Explicit adoption

The coordinator SHALL immediately follow an explicitly selected existing native session without requiring initial input or a task.

#### Scenario: Adopts the selected existing worker

- **WHEN** a coordinator adopts a selected session
- **THEN** following binds that exact session and location to the initiating coordinator without changing its agent or sending input.

#### Scenario: Accepts task-free adoption without inventing a binding

- **WHEN** a root or child session is adopted without a task
- **THEN** background following starts without a send, criteria, observer snapshot, supervision start or resume step.
- **AND** existing pending permission and form requests are surfaced to the coordinator.

#### Scenario: Rejects competing ownership

- **WHEN** another coordinator that has an active run already follows the selected session
- **THEN** adoption reports the conflict without taking over that follower.

#### Scenario: Takes over from an idle or vanished coordinator

- **WHEN** the coordinator following the selected session is idle or its session no longer exists
- **THEN** following transfers to the adopting coordinator without messaging or interrupting the worker, and pending events carry over.
- **AND** the adoption result names the previous coordinator and the reason for the takeover.

#### Scenario: Rejects stale or denied task-free adoption

- **WHEN** configured permissions deny adoption or the selected native session is unavailable
- **THEN** no follower is created and no substitute target or initial message is used.

#### Scenario: Adopts an archived session

- **WHEN** a coordinator adopts an archived session selected by exact identity
- **THEN** following binds that session under configured permissions.
