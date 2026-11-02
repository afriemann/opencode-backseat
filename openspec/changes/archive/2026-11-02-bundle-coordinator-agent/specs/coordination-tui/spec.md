# Spec Delta

## REMOVED Requirements

### Requirement: Guided coordinator startup

**Reason:** Coordination starts through the dedicated native agent, not a session-creation or assignment wizard.
**Migration:** Select Conman Coordinator in the native agent picker at the canonical home; use the existing native attachment and supervision controls separately when needed.

## ADDED Requirements

### Requirement: Dedicated coordinator entry

The terminal interface SHALL use native selection of the bundled coordination agent as its sole coordination entry path while retaining supporting approval, status and supervision controls.

#### Scenario: Starts through the dedicated native agent

- **WHEN** the user selects Conman Coordinator at the canonical home and starts a conversation
- **THEN** the session uses the dedicated role and its coordination toolset without a setup wizard, dummy message or automatic observer attachment.
- **AND** coordination controls reject unrelated agents and conflicting user-defined roles rather than repurposing them.

#### Scenario: Keeps native supervision explicit

- **WHEN** the user inspects coordination state or converses with the dedicated agent
- **THEN** no session creation, agent reassignment, observer approval or supervision arming is performed by overview inspection.
- **AND** native attachment approval and explicit supervision rearm remain separate actions; unreadable or ineligible coordinator state stays stopped with a visible reason.
