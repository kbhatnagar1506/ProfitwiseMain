# `components/`

React components. 33 at the top level plus three subdirectories.

| Path | Contents |
| --- | --- |
| `ui/` | [shadcn/ui](https://ui.shadcn.com) primitives over Radix — button, dialog, table, chart, sidebar. **Generated code.** Prefer configuring over editing; a regeneration will overwrite local changes. |
| `dashboard/` | Application shell — sidebar navigation, top bar, bottom bar, layout, sync-status poller |
| `shared/` | Cross-surface domain widgets — AR/AP reconciliation table, entity graph display, cash forecast chart, movement classification table |
| *(top level)* | Feature components — entity detail panels, customer and vendor drawers, confidence breakdown, risk gauge, onboarding flow |

---

## Conventions

**Server Components by default.** Add `"use client"` only when the component
actually needs state, effects or browser APIs. Data fetching belongs on the
server side wherever it can.

**Display names go through `lib/alias-normalize.ts`.** Never render a raw bank
descriptor. `displayLabelForCounterparty()` handles owner redaction, invoice
sludge, Plaid's `(deleted)` suffix and canonical brand spacing. Bypassing it is
how `QuickBooks` ends up rendered as `Quick Books`.

**Styling is Tailwind + `cn()`** from `lib/utils.ts` for conditional classes.
Follow the variant patterns already in `ui/` rather than inventing new ones.

**Static assets live in `assets/`** and are imported (`@/assets/whatsapp-qr.png`),
which gets them hashed and optimised. `public/` is for files that must keep a
stable public URL.

---

## Testing

No component tests yet. The suite currently targets the domain layer in `lib/`,
where the financial correctness risk sits. If you add component tests, keep them
hermetic — no network, no database — consistent with the rest of the suite.
