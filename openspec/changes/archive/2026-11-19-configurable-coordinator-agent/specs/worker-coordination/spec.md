## MODIFIED Requirements

### Requirement: Bundled conversational coordinator

The plugin SHALL provide a selectable primary coordinator agent, named by the `agentID` and `agentName` plugin options, wherever it is enabled without replacing user definitions or changing the default agent or selected model.

#### Scenario: Registers the coordinator in every enabled project

- **WHEN** the plugin loads in multiple enabled project directories without a conflicting agent definition
- **THEN** the configured coordinator identifier is available as a primary agent with no model override in each project, without requiring a session in the data directory.
- **AND** repeated registry rebuilds and plugin disposal do not duplicate or leave stale bundled registrations.
- **AND** inherited allow, ask or deny rules appended to the coordinator's permission prefix do not make an otherwise matching role unavailable.

#### Scenario: Preserves a configured coordinator agent

- **GIVEN** a user-defined agent already has the coordinator identifier
- **WHEN** plugin registration is evaluated
- **THEN** that definition, its permissions and model remain unchanged; no coordinator behavior is inferred solely from its name.
- **AND** a definition with the same identifier, exact coordinator instructions, visible primary mode and exact ordered coordinator permission prefix receives the same restricted coordinator behavior, regardless of inherited suffix rules or display name; recognition does not authenticate authorship.
- **AND** a different definition stays user-controlled and unavailable as the coordinator rather than being overwritten or repurposed.
- **AND** a validation diagnostic names the `agentID` option when a different definition holds the identifier.

#### Scenario: Allows Backseat operations by default

- **WHEN** the coordinator invokes a Backseat native operation and no inherited rule matches its `backseat.` permission action
- **THEN** the operation is allowed, while an inherited ask or deny rule appended to the coordinator's permission prefix still applies.

#### Scenario: Uses default identifier and name

- **WHEN** neither `agentID` nor `agentName` is configured
- **THEN** the coordinator is registered as `backseat` with the display name `Backseat`.

#### Scenario: Registers a configured identifier and name

- **WHEN** `agentID` is `lead` and `agentName` is `Team Lead`
- **THEN** the coordinator is registered with identifier `lead` and display name `Team Lead`.
- **AND** confinement, role matching and exclusion from worker assignment and the agent listing apply to `lead` and not to `backseat`.

#### Scenario: Rejects invalid coordinator options

- **WHEN** `agentID` is not a string of at most 32 characters that starts with a lowercase letter, ends with a lowercase letter or digit and contains only lowercase letters, digits and hyphens, or `agentName` is not a non-empty trimmed string of at most 64 characters without control characters
- **THEN** no coordinator is registered and a validation diagnostic names the invalid option without echoing its value.

### Requirement: Diagnostic privacy boundary

Backseat SHALL restrict diagnostic records to a closed allowlist of fixed event, operation, phase, failure, request-category, error-code and configuration-option labels, integer HTTP statuses from 100 through 599, nonnegative finite durations and counts, continuation-presence booleans, and independent diagnostic-only tokens.

#### Scenario: Excludes sensitive diagnostic data

- **WHEN** input, native metadata or an exception contains sensitive or arbitrary values at any logging level
- **THEN** diagnostics exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs and content-derived hashes
- **AND** existing detailed user-facing registration errors remain unchanged
- **AND** both the native producer and host projection reject arbitrary labels and invalid numbers independently, using fixed unknown categories or codes rather than exception text
- **AND** exceptional diagnostic property access or emission does not change results, original errors, permission checks, cancellation or cleanup
