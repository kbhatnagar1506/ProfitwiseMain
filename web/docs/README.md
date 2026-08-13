# Application documentation

Reference material for the app in [`../`](../). For product context and the
overall architecture, start with the [repository README](../../README.md).

---

## Architecture

| Document | Contents |
| --- | --- |
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | End-to-end flow: ingestion → classification → reconciliation → UI. **Read this first.** |
| [RECONCILIATION_LAYER.md](RECONCILIATION_LAYER.md) | The five-stage waterfall in detail, with entry points |
| [ar-ap-architecture.md](ar-ap-architecture.md) | `cash_events.status` as single source of truth, and its six permitted write paths |
| [CLASSIFICATION_PRECEDENCE.md](CLASSIFICATION_PRECEDENCE.md) | How competing movement classifications are resolved |
| [ENTITY_GRAPH_INTEGRATION.md](ENTITY_GRAPH_INTEGRATION.md) | Identity resolution and the entity graph |
| [IDENTITY_GRAPH_MAINTAINER.md](IDENTITY_GRAPH_MAINTAINER.md) | Scheduled graph maintenance |
| [BULL_QUEUE_IMPLEMENTATION.md](BULL_QUEUE_IMPLEMENTATION.md) | Background job processing |
| [FORECAST_ROADMAP.md](FORECAST_ROADMAP.md) | Forecasting direction |

## Integration setup

| Document | Covers |
| --- | --- |
| [DATABASE_SETUP.md](DATABASE_SETUP.md) | PostgreSQL and Cloud SQL |
| [PLAID_SETUP.md](PLAID_SETUP.md) | Bank movement sync |
| [QBO_HEROKU_AND_INTUIT_SETUP.md](QBO_HEROKU_AND_INTUIT_SETUP.md) | QuickBooks OAuth and deployment |
| [XERO_SETUP.md](XERO_SETUP.md) | Xero OAuth |
| [SLACK_SETUP.md](SLACK_SETUP.md) | Slack app and events |
| [TWILIO_WHATSAPP_SETUP.md](TWILIO_WHATSAPP_SETUP.md) | WhatsApp via Twilio |
| [GCP_ENTITY_BUCKET_SETUP.md](GCP_ENTITY_BUCKET_SETUP.md) | Entity blob storage |

> `TWILIO_WHATSAPP_SETUP.md` is load-bearing: it documents the `/api/twillo/…`
> webhook URL — misspelled, and deliberately so, because that is the URL
> configured in the Twilio console. Do not "fix" the route without repointing
> Twilio first.

## Operations

| Document | Covers |
| --- | --- |
| [ADMIN_WIPE_USER_DATA.md](ADMIN_WIPE_USER_DATA.md) | The destructive admin endpoint and its guards |

---

## Directory READMEs

Closer to the code, and more likely to stay current:

[`lib/`](../lib/README.md) · [`lib/state/`](../lib/state/README.md) ·
[`lib/queue/`](../lib/queue/README.md) · [`app/api/`](../app/api/README.md) ·
[`components/`](../components/README.md) · [`migrations/`](../migrations/README.md) ·
[`scripts/`](../scripts/README.md)

## Engineering review

[`REVIEW.md`](../../REVIEW.md) — findings, known-unfixed defects and the testing
roadmap. Read it before changing confidence scoring or the reconciliation
waterfall.
