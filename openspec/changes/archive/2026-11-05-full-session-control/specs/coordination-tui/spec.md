# Spec Delta

## REMOVED Requirements

### Requirement: Native project and worker selection

**Reason**: Native session coordination is agent-only.
**Migration**: Select the bundled coordinator agent and use its project, agent and session discovery tools.

### Requirement: Accessible coordination overview

**Reason**: Terminal coordination views are outside the agent-only interface.
**Migration**: Request structured session and task status from the coordinator agent.

### Requirement: Authoritative native worker actions

**Reason**: Worker control belongs to the coordinator agent rather than terminal actions.
**Migration**: Request the corresponding agent tool operation and approve its native operation-bound prompt.

### Requirement: Dedicated coordinator entry

**Reason**: The bundled coordinator agent is the sole interface without terminal attachment or supporting terminal controls.
**Migration**: Select the bundled primary agent normally; request supervision start, hold, resume or recovery through its tools.
