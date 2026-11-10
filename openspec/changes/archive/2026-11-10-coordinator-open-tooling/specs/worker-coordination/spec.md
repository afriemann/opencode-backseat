## MODIFIED Requirements

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles from built-in implementation tools while leaving other configured tools eligible under native OpenCode permissions.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator invokes a native control
- **THEN** configured allow proceeds without a forced Backseat ask, configured ask requests approval and configured deny rejects the operation.
- **AND** the `backseat` namespace, `backseat_` tool identifiers and `backseat.` permission actions remain consistent, without aliases or terminal UI.
- **AND** worker content is evidence, not a user instruction; the coordinator can still judge actions and worker request replies.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** creation targets a matching coordinator agent as a worker
- **THEN** the target is rejected without changing another agent.

#### Scenario: Rejects disallowed coordinator tool execution

- **WHEN** a matching coordinator requests `shell`, `bash`, `edit`, `write`, `patch`, `read`, `glob`, `grep`, `webfetch`, `subagent`, `skill`, or a tool in the `lsp_` or `use_` families
- **THEN** it is absent from the prompt-facing tool catalog and execution is rejected independently of context filtering, including nested Code Mode calls and inherited allow rules.
- **AND** configured denials remain final.

#### Scenario: Preserves cross-project control under inherited policy

- **WHEN** a coordinator controls a selected session in another project
- **THEN** the operation uses the selected native location without requiring terminal attachment or a coordinator in the storage directory.

#### Scenario: Allows configured coordination tools and session-local tracking

- **WHEN** a matching coordinator uses an available configured tool outside the built-in implementation denials, including session-local todo tools
- **THEN** Backseat neither removes it from the prompt-facing catalog nor rejects its execution.
- **AND** tools for unrelated agents remain unaffected.

#### Scenario: Asks for unmatched coordination tool actions

- **WHEN** a tool checks a permission action with no specific matching coordinator rule or inherited override
- **THEN** the bundled permission fallback is ask, while `execute`, `question`, available `todowrite` and `todoread`, and Backseat actions retain allow defaults.
- **AND** inherited allow, ask or deny rules still override those defaults without changing coordinator recognition.
- **AND** Backseat does not add a universal permission assertion to custom plugin tools that do not check their own permissions.
