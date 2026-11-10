## Why

The coordinator must pass an exact provider, model ID and variant to `switch_session_model` but has no way to discover valid values.

## What Changes

- Add a `list_models` coordination tool that lists enabled native models at a location.
- Allow it for the coordinator and mention it in the coordinator prompt.

## Product intent

Actor: the coordinator agent, trusted to choose worker models. Job: pick a valid model for `switch_session_model` without guessing IDs. Must keep: bounded, location-scoped discovery that fails clearly when the host list is unavailable or mismatched.
