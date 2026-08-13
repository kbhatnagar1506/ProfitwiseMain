# `lib/state/`

Derived financial state: what the business currently looks like, and what it is
likely to look like next. Everything here is computed from movements,
attributions and cash events — nothing in this directory is a source of record.

| File | Lines | Role |
| --- | ---: | --- |
| `forecast-engine.ts` | ~5,800 | Cash forecasting. The largest module in the repository. |
| `forecast-calibration.ts` | ~1,100 | Tunes forecast parameters against realised outcomes |
| `types.ts` | ~1,050 | Shared state shapes — `LiquidityState`, `ARState`, `APState`, … |
| `compute.ts` | ~840 | Assembles the composite state object |
| `risk-engine.ts` | — | Risk scoring and factor attribution |
| `insight-engine.ts` | — | Narrative insights surfaced on the dashboard |
| `ar-ap.ts`, `ar-ap-from-attributions.ts` | — | AR/AP position, derived from attributions |
| `behavioral-timing-ar.ts` | — | Per-entity payment timing behaviour |
| `index.ts` | — | Public entrypoint — import from here, not from internals |
| `constants.ts` | — | Shared thresholds |

---

## Conventions

**Import from `index.ts`.** It is the intended surface. Reaching into
`forecast-engine.ts` directly couples callers to internals that are expected to
move as this directory gets decomposed.

**State is derived, never authoritative.** `cash_events.status` is the source of
truth for AR/AP (see
[`ar-ap-architecture.md`](../../docs/ar-ap-architecture.md)). Nothing here should
write it. If you need a status change, go through `lib/ar-ap-status.ts`.

**Calibration is a feedback loop.** `forecast-calibration.ts` compares forecasts
against realised cash and adjusts parameters. It runs on a schedule via
`/api/cron/forecast-calibration-tune`. Changing forecast maths without
considering calibration means the loop will fight your change.

---

## Working here

This is the least-tested large surface in the repository, and `forecast-engine.ts`
at ~5,800 lines is the single hardest module to reason about. The practical route
to coverage is to extract the pure calculation helpers — the parts that take
numbers and return numbers — and property-test those first, rather than
attempting to test the engine whole.

Some `LiquidityState` fields are accessed by callers but not declared on the
type (`total_in`, `total_out`), which currently surfaces as suppressed type
errors rather than build failures. See `REVIEW.md` §3.2 before adding fields.

Roadmap: [`FORECAST_ROADMAP.md`](../../docs/FORECAST_ROADMAP.md).
