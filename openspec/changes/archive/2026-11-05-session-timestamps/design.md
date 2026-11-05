## Context

The proposal defines scope and timestamp semantics; the worker-coordination delta spec defines the behavioral contract.

## Decisions

Extend the existing `sessionMetadata` mapping for both timestamps. Reusing this single mapping keeps list and detail metadata consistent without duplicate projection logic.

Keep the native refresh/fallback flow: successful detail reads supply refreshed metadata; failed reads retain available metadata. Continuations reuse that flow without additional requests or storage.

Prefer direct native values over derived activity timestamps. Activity tracking, local sorting and new abstractions add complexity without serving the stated scope.

## Risks / Trade-offs

Fallback timestamps can be older than refreshed metadata. Native update recency is not proof of conversation activity or completion.
