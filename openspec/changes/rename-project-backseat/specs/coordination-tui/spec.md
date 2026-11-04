# Spec Delta

## MODIFIED Requirements

### Requirement: Dedicated coordinator entry

The terminal interface SHALL use native selection of the bundled coordination agent as its sole coordination entry path while retaining supporting approval, status and supervision controls.

#### Scenario: Starts through the dedicated native agent

- **WHEN** the user selects Backseat Coordinator in any enabled project and starts a conversation
- **THEN** the session uses the dedicated role and its coordination toolset without navigating to the data directory, a setup wizard, dummy message or automatic observer attachment.
- **AND** coordination controls reject unrelated agents and conflicting user-defined roles rather than repurposing them.

#### Scenario: Keeps native supervision explicit

- **WHEN** the user inspects coordination state or converses with the dedicated agent
- **THEN** no session creation, agent reassignment, observer approval or supervision arming is performed by overview inspection.
- **AND** bootstrap shows only store and availability metadata before approved attachment; full inventory follows successful attachment, then reconciliation and a separate explicit rearm.
- **AND** unreadable or ineligible coordinator state stays stopped with a visible reason; conversation location, store identity and explicit worker project locations remain distinct.
