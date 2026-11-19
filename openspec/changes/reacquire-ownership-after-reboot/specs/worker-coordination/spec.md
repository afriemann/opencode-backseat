# Spec Delta

## MODIFIED Requirements

### Requirement: Exclusive coordinator authority

The coordinator SHALL serialize mutations through one local authority for its selected durable store.

#### Scenario: Holds a competing or unsafe authority

- **WHEN** store ownership cannot be acquired or storage is unsafe
- **THEN** mutations report unavailable authority while native inventory remains accessible.
- **AND** projects selecting the same store share serialized publication.

#### Scenario: Reacquires terminated ownership without arming supervision

- **WHEN** a reload acquires the store's exclusive lock
- **THEN** saved followers resume observation without supervision approval, preserving unresolved delivery identities.

#### Scenario: Reacquires ownership left by a previous boot

- **WHEN** the store's unreleased ownership record was written under a different host boot
- **THEN** the coordinator reacquires the store as the new owner.

#### Scenario: Revalidates terminated ownership under exclusive acquisition

- **WHEN** competing processes attempt to acquire the store
- **THEN** only the exclusive lock holder publishes state and lock files are not deleted to bypass exclusion.

#### Scenario: Fences an unloaded project without releasing other participants

- **WHEN** a project unloads
- **THEN** its in-flight operations are cancelled without releasing another participant's store authority or killing workers.
- **AND** saved followers remain available for automatic replay on reload.
