# Documentation

Repository-level operational docs. Most documentation lives closer to the code
it describes.

| Document | Contents |
| --- | --- |
| [QUICK_START_GUIDE.md](QUICK_START_GUIDE.md) | Fast local setup |
| [BACKGROUND_REFRESH_JOBS.md](BACKGROUND_REFRESH_JOBS.md) | Scheduled refresh jobs and the `refresh_jobs` table |

---

## Where everything else is

| Looking for | Go to |
| --- | --- |
| What Profitwise does, the reconciliation model, the stack | [Repository README](../README.md) |
| Running the app, commands, testing conventions | [`web/README.md`](../web/README.md) |
| Architecture and integration setup guides | [`web/docs/`](../web/docs/README.md) |
| Known defects, suppressed type errors, testing roadmap | [`REVIEW.md`](../REVIEW.md) |

Directory-level READMEs sit next to the code and are the most likely to be
accurate: [`lib/`](../web/lib/README.md) ·
[`lib/state/`](../web/lib/state/README.md) ·
[`lib/queue/`](../web/lib/queue/README.md) ·
[`app/api/`](../web/app/api/README.md) ·
[`components/`](../web/components/README.md) ·
[`migrations/`](../web/migrations/README.md) ·
[`scripts/`](../web/scripts/README.md)

---

## A note on this directory

It previously held 31 documents — eight overlapping data-quality reports, five on
classification, plus assorted point-in-time audits and planning files. They were
snapshots of work in progress rather than reference material, and they
contradicted each other as the code moved past them.

They were removed rather than left to mislead. Everything remains in git history
if you need it:

```bash
git log --diff-filter=D --name-only -- docs/
git show <commit>^:docs/<file>
```

Prefer adding to the directory READMEs or `REVIEW.md` over adding another
standalone analysis document here.
