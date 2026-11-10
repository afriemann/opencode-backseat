## ADDED Requirements

### Requirement: Session recap

The coordinator SHALL be able to recap a selected native session through a dedicated tool governed by configured OpenCode permissions.

#### Scenario: Recaps a session with its subagents listed

- **WHEN** a coordinator recaps a session by exact identity, optionally with a focus
- **THEN** the session's own model generates the recap without inserting a message, and the result lists the session's direct child sessions with id, title, agent and status.

#### Scenario: Recaps a subagent on demand

- **WHEN** a coordinator recaps a child session using the id returned by an earlier recap
- **THEN** that child is recapped and its own children are listed.
