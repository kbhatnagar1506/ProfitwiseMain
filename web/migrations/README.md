# `migrations/`

Schema changes reach the database two different ways in this project. Knowing
which one you are touching matters.

---

## 1. `ensure*Schema()` in `lib/db.ts` — the main path

Fifteen `ensureXSchema()` functions (`ensureAuthSchema`, `ensureMovementsSchema`,
`ensurePlaidSchema`, …) issue idempotent `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE` statements at runtime. Routes call the ones they need before
querying, and each function short-circuits after its first successful run in a
process.

This is where the large majority of the schema actually lives.

**To add a column:** extend the relevant `ensure*Schema()` with a guarded
`ALTER TABLE`, following the existing pattern — the surrounding code swallows
`already exists` / `duplicate column` errors so a re-run is a no-op.

**Then add the matching rollback** to `lib/db-rollback.ts`. Every numbered
migration step there pairs with a change in `ensureMovementsSchema()`, and the
pairing is by hand — nothing enforces it, so an unpaired change is a rollback
that silently does not undo what you added.

```bash
npm run db:list-migrations      # show known versions
npm run db:rollback -- <version>  # roll back TO (not including) a version
```

Rollbacks are destructive and drop data. Back up first and run them in a
maintenance window.

## 2. SQL files in this directory

Standalone `.sql` files applied by `run-migrations.sh` from the repository root,
in filename order:

```bash
./run-migrations.sh      # requires DATABASE_URL and psql
```

Currently: `001_create_refresh_jobs.sql`.

Use this path for things that do not fit the idempotent-DDL model — data
backfills, index builds you want to control explicitly, constraint changes that
need a specific ordering.

---

## Data migrations

One-off transformations of existing rows live in `lib/migrations/` as TypeScript
(e.g. `migrate-ar-matches.ts`), not as SQL. They are run manually with `tsx`.

---

## Caveats

**There is no migration ledger.** Nothing records which SQL files have been
applied to which database; `run-migrations.sh` simply replays every file each
time. That is safe only while the files stay idempotent — write them that way.

**Do not assume ordering between the two paths.** `ensure*Schema()` runs on
demand at request time; the SQL files run when you invoke the script. If a SQL
file depends on a table created by an `ensure*Schema()`, that table may not exist
yet on a fresh database.
