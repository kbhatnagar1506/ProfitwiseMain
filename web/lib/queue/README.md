# `lib/queue/`

Background job processing on [Bull](https://github.com/OptimalBits/bull) over
Redis. Runs as its own process — the `worker` dyno in the `Procfile` — so nothing
here executes inside a request.

```bash
npm run worker    # tsx lib/queue/worker.ts
```

---

## Layout

| File | Role |
| --- | --- |
| `worker.ts` | Process entrypoint. Registers every processor and starts consuming. |
| `bull-client.ts` | Queue construction and the shared Redis connection |
| `bull-config.ts` | Retry, backoff and concurrency settings |
| `job-types.ts` | Job name constants and payload types — the contract between producer and consumer |
| `queue-wrapper.ts` | Enqueue helpers used by route handlers |
| `queue-logger.ts` | Structured job lifecycle logging |
| `connection-monitor.ts` / `redis-monitor.ts` | Connection health and reconnection |

## Processors

`processors/` holds seven consumers:

| Processor | Work |
| --- | --- |
| `sync-initial-data` | First full pull after an integration connects |
| `process-webhook` | Provider webhook payloads, handled off the request path |
| `tag-movements` | Assign economic class to bank movements |
| `classify-movements` | Movement class, confidence, review flags |
| `match-customers` | Entity resolution against the customer graph |
| `compute-state` | Derived AR/AP and liquidity state |
| `generate-forecast` | Forecast runs |

The ordering above is roughly the ingestion pipeline: sync → tag → classify →
match → compute → forecast.

---

## Conventions

**`bull` and `redis` are server externals.** `next.config.js` marks them so they
are not bundled. Never import from this directory in a Client Component or any
module reachable from one.

**Jobs must be idempotent.** Bull retries on failure, and webhook delivery is
at-least-once. A processor that runs twice on the same payload must not double
an attribution or duplicate a movement.

**Enqueue, do not inline.** If a route handler is about to do something slow —
a full sync, a reconciliation run, an LLM sweep — it belongs on a queue with the
route returning a status the client can poll.

**Payload types live in `job-types.ts`.** Changing a payload shape without
updating it there breaks the producer/consumer contract silently, since the
queue carries plain JSON.

---

## Testing

No coverage. These processors reach Redis and Postgres on import, so they need
the same seam around `query<T>()` discussed in [`../README.md`](../README.md)
before they can be unit tested. Setup notes:
[`BULL_QUEUE_IMPLEMENTATION.md`](../../docs/BULL_QUEUE_IMPLEMENTATION.md).
