# ADR 0002 — SQLite + R\*Tree store now, PostGIS as the deployment target

**Status:** accepted · **Date:** 2026-11-11

## Context

The API and the agent need spatial queries (bbox, extent, aggregate) and the build must
run on a laptop with no server, no Docker daemon and no database credentials. The
deployment target for a real twin, however, is a shared PostGIS instance.

## Decision

Use a single-file SQLite store with an R\*Tree index for the prototype, behind a small
`FeatureStore` interface (`create`, `add_collection`, `bbox`, `extent`, `get`,
`aggregate`). Provide `deploy/postgis/init.sql` and a compose service so the same schema
can be provisioned in PostGIS without touching the API or agent code.

## Why

- **Reproducibility**: a reviewer clones and runs; no Docker, no port conflicts.
- **Portability of the interface**: the API layer calls only `FeatureStore` methods, so
  a PostGIS implementation swaps one module.
- **Honest scope**: GiST/BRIN tuning, concurrent writers and transactions belong to the
  deployment, not to a portfolio prototype; pretending otherwise would be noise.

## Consequences

- No concurrent writes; the store is rebuilt by the pipeline.
- Attribute filtering is implemented in Python over a bbox-restricted candidate set —
  fine at 3 000 rows, not at 3 million. The PostGIS schema uses JSONB + GiST to make
  the same filters indexable.
- Schema drift is caught by tests that assert collection metadata (CRS, id column,
  property types).
