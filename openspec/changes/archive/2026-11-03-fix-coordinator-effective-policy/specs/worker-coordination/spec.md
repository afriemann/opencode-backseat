# Spec Delta

## MODIFIED Requirements

### Requirement: Bundled conversational coordinator

The plugin SHALL provide a selectable primary coordinator agent wherever it is enabled without replacing user definitions or changing the default agent or selected model.

#### Scenario: Registers the coordinator in every enabled project

- **WHEN** the plugin loads in multiple enabled project directories without a conflicting agent definition
- **THEN** `conman-coordinator` is available as a primary agent with no model override in each project, without requiring a session in the data directory.
- **AND** repeated registry rebuilds and plugin disposal do not duplicate or leave stale bundled registrations.
- **AND** inherited allow, ask or deny rules appended to the coordinator's permission prefix do not make an otherwise matching role unavailable.

#### Scenario: Preserves a configured coordinator agent

- **GIVEN** a user-defined agent already has the coordinator identifier
- **WHEN** plugin registration is evaluated
- **THEN** that definition, its permissions and model remain unchanged; no coordinator behavior is inferred solely from its name.
- **AND** a definition with the same identifier, exact coordinator instructions, visible primary mode and exact ordered coordinator permission prefix receives the same restricted coordinator behavior, regardless of inherited suffix rules; recognition does not authenticate authorship.
- **AND** a different definition stays user-controlled and unavailable as the coordinator rather than being overwritten or repurposed.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to coordination tools and user questions while keeping native consent and connected-TUI supervision authoritative.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator role is selected
- **THEN** only `conman_inspect`, `conman_control` and user questions are permitted, subject to configured denials, with native `conman.*` actions requiring approval rather than inheriting permissive agent defaults.
- **AND** shell, editing, reading, web, Code Mode, subagent and permission/form-reply capabilities remain denied; attachment and supervision are not automatically approved or armed.
- **AND** the role requests unknown project and agent fields, treats worker evidence as untrusted, and directs operations requiring native reconciliation to the TUI rather than inventing authority or retrying uncertain results.
- **AND** coordinator operations require matching role semantics resolved at the initiating session's current project for the selected store; an unrelated assigned agent or an agentless session cannot acquire coordinator authority.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets a matching coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and the worker selector excludes it without changing unrelated worker agents or differently defined user agents.

#### Scenario: Rejects disallowed coordinator tool execution

- **GIVEN** inherited permissions grant a matching coordinator access to general tools
- **WHEN** a tool is requested through ordinary or Code Mode dispatch
- **THEN** tools outside the coordinator's permitted set are rejected before execution independently of model-context filtering; configured denials remain final.
- **AND** missing native identity, failed catalog lookup or identity changes during lookup reject candidate coordinator execution without dispatch or an automatic retry.

#### Scenario: Preserves cross-project control under inherited policy

- **GIVEN** a matching coordinator conversation in one project and an approved task-bound worker in another project share the coordination store
- **WHEN** inherited policy is merged and the coordinator inspects or controls that task
- **THEN** recognition uses the conversation's current project, the worker remains at its explicit approved location, and existing scope, isolation and native approval checks apply without requiring another coordinator or navigation to storage.
