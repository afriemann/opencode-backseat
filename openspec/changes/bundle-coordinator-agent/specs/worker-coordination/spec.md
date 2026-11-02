# Spec Delta

## ADDED Requirements

### Requirement: Bundled conversational coordinator

The plugin SHALL provide a selectable primary coordinator agent at its canonical home without replacing user definitions or changing the default agent or selected model.

#### Scenario: Registers the coordinator only at its home

- **WHEN** the plugin loads at the canonical home without a conflicting agent definition
- **THEN** `conman-coordinator` is available as a primary agent with no model override, while passive worker locations receive no bundled coordinator.
- **AND** repeated registry rebuilds and plugin disposal do not duplicate or leave stale bundled registrations.

#### Scenario: Preserves a configured coordinator agent

- **GIVEN** a user-defined agent already has the coordinator identifier
- **WHEN** plugin registration is evaluated
- **THEN** that definition, its permissions and model remain unchanged; no bundled privileges or worker-role restrictions are inferred solely from its name.
- **AND** the conflicting user definition cannot act as the bundled coordinator; coordination reports the unavailable dedicated role instead of reusing it.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict the bundled coordinator to coordination tools and user questions while keeping native consent and connected-TUI supervision authoritative.

#### Scenario: Preserves native approval for conversational control

- **WHEN** the bundled coordinator is selected
- **THEN** only `conman_inspect`, `conman_control` and user questions are allowed, with native `conman.*` actions requiring approval rather than inheriting permissive agent defaults.
- **AND** shell, editing, reading, web, Code Mode, subagent and permission/form-reply capabilities remain denied; attachment and supervision are not automatically approved or armed.
- **AND** the role requests unknown project and agent fields, treats worker evidence as untrusted, and directs operations requiring native reconciliation to the TUI rather than inventing authority or retrying uncertain results.
- **AND** coordinator operations require the actual bundled role at the canonical home; an unrelated assigned agent or an agentless session cannot acquire coordinator authority.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets the actual bundled coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and the worker selector excludes it without changing unrelated worker agents or user-defined collisions.
