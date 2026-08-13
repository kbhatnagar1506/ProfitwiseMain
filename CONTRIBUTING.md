# Contributing

**This is a read-and-reference repository.** The code is published so it can be
read, studied and run — not collectively developed. Direct write access is not
granted, and changes land only through review by the owner.

That is a deliberate posture, not an oversight. Profitwise moves real money
between real bank accounts. An unreviewed change to the reconciliation waterfall
does not produce a rendering glitch — it mis-attributes a payment.

---

## What you can do

**Read it.** Start with the [README](README.md), then [USAGE.md](USAGE.md) for
how to run it, [CONNECTORS.md](CONNECTORS.md) for the integration surface, and
[REVIEW.md](REVIEW.md) for what is knowingly broken.

**Run it.** [USAGE.md](USAGE.md) walks through local setup. It runs with zero
connectors configured — you just have nothing to reconcile until you add one.

**Fork it.** Subject to the licence (see below), fork freely and take it in your
own direction. You do not need permission to experiment.

**Report something.** Open an issue for a bug, a documentation error, or a
question. For anything security-related, follow [SECURITY.md](SECURITY.md) and
do **not** open a public issue.

**Propose a change.** Pull requests are read and considered. Open an issue first
for anything non-trivial, so effort is not spent on a change that will not be
merged.

---

## If you do open a pull request

Requirements, in the order they will be checked:

1. **Tests pass.** `cd web && npm test` — 213 tests, hermetic, no network or
   database. CI gates this.
2. **No new type errors.** `npm run typecheck`. The existing 349 are a known
   backlog; adding to it is not accepted.
3. **New logic is tested.** Particularly anything touching money — matching,
   confidence scoring, AR/AP status.
4. **You did not "fix" a `CHARACTERISATION` or `KNOWN GAP` test.** Those pin
   behaviour that is known to be wrong so it cannot drift silently before
   someone decides how it should work. If one fails, read the matching entry in
   [REVIEW.md](REVIEW.md) before changing anything.
5. **Conventions followed.** Each directory has a README covering its own:
   [`lib/`](web/lib/README.md) · [`app/api/`](web/app/api/README.md) ·
   [`migrations/`](web/migrations/README.md) ·
   [`components/`](web/components/README.md) ·
   [`lib/queue/`](web/lib/queue/README.md)

The four that catch people out:

- Pass the type argument to `query<T>()`. It defaults to `unknown`.
- Only `lib/ar-ap-status.ts` may write `cash_events.status`.
- Every new route picks one of the five auth tiers deliberately.
- Never render a raw bank descriptor — go through
  `displayLabelForCounterparty()`.

Changes to reconciliation, confidence scoring, authentication, the admin and
cron endpoints, or the database layer require owner review under
[CODEOWNERS](.github/CODEOWNERS), and will be held to a higher bar than the
rest of the codebase.

---

## Repository protection

`main` and `production` are protected. Nobody — including the owner — can push
to them directly or force-push over them; everything lands through a reviewed
pull request with CI green.

Required settings, for reference and so drift is detectable:

| Setting | Value |
| --- | --- |
| Require a pull request before merging | ✅ |
| Required approvals | 1 |
| Require review from Code Owners | ✅ |
| Dismiss stale approvals on new commits | ✅ |
| Require status checks to pass | ✅ (`Unit tests`) |
| Require branches to be up to date | ✅ |
| Require conversation resolution | ✅ |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |
| Apply to administrators | ✅ |

`production` carries a curated history that shares no ancestor with `main`.
Updates to it are explicit merges, never fast-forwards or force pushes.

---

## Licence

Released under the [MIT License](LICENSE) — you may use, copy, modify and
distribute this code, including commercially, provided the copyright notice and
licence text are retained. The software is provided without warranty.

