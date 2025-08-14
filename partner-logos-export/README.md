# Partner logos export

This folder contains all **partner bank and integration logos** and the **React components** that display them, so you can reuse them in another repo.

## Contents

- **`images/`** – All logo files (banks + integrations). Copy this folder into your app’s `public/` (e.g. `public/partner-logos/images/`).
- **`PartnerBankLogos.tsx`** – Scrolling strip of bank logos (“Trusted by users from leading financial institutions”).
- **`PartnerIntegrations.tsx`** – Grid of integration logos (QuickBooks, Stripe, Gusto, etc.) with optional click handler.
- **`partner-banks-data.ts`** – Plain list of bank names and logo filenames if you only need the data.

## Use in another repo

1. Copy the `images/` folder into your project (e.g. `public/partner-logos/images/`).
2. Copy the component file(s) you need: `PartnerBankLogos.tsx` and/or `PartnerIntegrations.tsx`.
3. Point the component at your images with `imageBasePath`:

```tsx
// If images are at public/partner-logos/images/
<PartnerBankLogos imageBasePath="/partner-logos/images" />

// Integrations grid
<PartnerIntegrations imageBasePath="/partner-logos/images" onSelect={(name) => console.log(name)} />
```

4. Styling: components use Tailwind-style classes. If you don’t use Tailwind, the important parts are also expressed with inline `style` where needed so they work on a dark background. Adjust classes or styles to match your app.

## Logo filenames (banks)

`chase-logo.png`, `bofa-logo.png`, `wells-fargo-logo.png`, `citibank-logo.png`, `capital-one-logo.png`, `pnc-logo.png`, `us-bank-logo.png`, `td-bank-logo.png`, `truist-logo.png`, `hsbc-logo.png`, `goldman-sachs-logo.jpg`, `morgan-stanley-logo.jpg`, `amex-logo.jpg`, `discover-logo.jpg`, `ally-logo.jpg`, `schwab-logo.jpg`, `barclays-logo.jpg`, `santander-logo.jpg`, `citizens-logo.jpg`, `fifth-third-logo.jpg`, `keybank-logo.jpg`, `regions-logo.jpg`, `mt-bank-logo.jpg`, `navy-federal-logo.jpg`, `bmo-logo.jpg`, `usaa-logo.jpg`, `suntrust-logo.jpg`, `huntington-logo.jpg`

## Logo filenames (integrations)

`quickbooks-logo.png`, `stripe-logo.png`, `gusto-logo.png`, `ramp-logo.png`, `xero-logo.png`, `sage-logo.png`, `netsuite-logo.png`, `bill-logo.png`, `brex-logo.png`, `expensify-logo.png`, `rippling-logo.png`, `adp-logo.png`, `avalara-logo.png`, `tipalti-logo.png`
