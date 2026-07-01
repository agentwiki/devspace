# ADR-0004: Use Drizzle (not Prisma) for the persistence layer

- Status: accepted (supersedes the M0 Prisma choice)
- Date: 2026-07-01

## Context

M0 initially used Prisma. Prisma ships Rust engine binaries (schema-engine,
query-engine) that are downloaded from `binaries.prisma.sh` at install/runtime.
In this environment that download fails with `ECONNRESET` through the egress
proxy — even though the host is reachable and `curl` downloads the same binary
fine. The only Prisma-native fix was a curl-based engine-prefetch workaround that
has to be re-run after every install and in every CI / air-gapped environment.

The deeper problem is architectural: **this product ships to on-premises,
potentially air-gapped deployments.** A persistence tool that must fetch native
binaries from the public internet is a poor fit for the product's own deployment
target — the pain we hit in the dev sandbox would recur at customer sites.

## Decision

Replace Prisma with **Drizzle ORM** in `@devspace/db`.

- Schema is pure TypeScript in `src/schema.ts`.
- `drizzle-kit generate` emits SQL migrations **locally** — no DB connection and
  no binary download. Verified generating offline in this environment.
- Runtime uses `drizzle-orm` over the pure-JS `pg` driver. No native engine.
- The repository interfaces in `src/index.ts` are unchanged and driver-agnostic;
  the in-memory reference impl is unaffected. The Drizzle/`pg`-backed impl lands in M3.

## Consequences

- No runtime/install download step; works in restricted proxies and air-gapped
  installs — matching the product's on-prem target.
- Migrations are plain, reviewable SQL files under `packages/db/drizzle/`.
- Slightly more explicit than Prisma's generated client; acceptable trade-off.
- The curl engine-prefetch workaround and `db:validate` are removed.

## Alternatives considered

- **Kysely** — even lighter (query builder only), migrations hand-written in TS.
  Viable; Drizzle chosen for its schema DSL + generated SQL migrations.
- **Keep Prisma + prefetch script** — retains the workaround and the air-gap
  liability. Rejected.
