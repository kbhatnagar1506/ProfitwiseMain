"use client"

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-black text-foreground font-sans">
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 md:py-16">
        <h1 className="text-2xl md:text-3xl font-semibold">Privacy Policy</h1>
        <p className="text-xs text-muted-foreground">Effective Date: February 23, 2026</p>

        <p>
          ProfitWise Inc. (&quot;ProfitWise&quot;, &quot;we&quot;) respects your privacy. This Privacy Policy explains how we collect,
          use, and protect data when you use our AI accounting Services.
        </p>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">1. Data We Collect</h2>
          <h3 className="text-sm font-medium">Business Financial Data (for Services):</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Bank and credit card transactions</li>
            <li>Accounting records (QuickBooks Online, Xero, FreshBooks)</li>
            <li>Invoices, receipts, contracts (from email and cloud storage such as Drive)</li>
            <li>Communication history (Gmail, Slack, WhatsApp for collections)</li>
          </ul>

          <h3 className="text-sm font-medium pt-2">Account Data:</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Business name, EIN/tax ID, contact information</li>
            <li>Billing and payment details</li>
          </ul>

          <h3 className="text-sm font-medium pt-2">Usage Data:</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Interactions with Wise AI</li>
            <li>Device and browser information, IP address</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">2. How We Use Data</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Deliver Services: automate reconciliation, categorization, reporting, and invoice chasing.</li>
            <li>Improve AI: use aggregated and anonymized data to train Wise (no individual business data is exposed).</li>
            <li>Compliance: CPA review and audit trails.</li>
            <li>Communications: service updates and billing.</li>
            <li>Security: fraud detection and access logs.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">3. Data Sharing</h2>
          <p>We never sell your data.</p>
          <p>We share data only with:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Service Providers: Plaid (banks), AWS (hosting), Stripe (payments), and accountants (review).</li>
            <li>Legal Authorities: only when required by law (e.g., subpoena or audit).</li>
            <li>
              Business Transfers: in a merger or acquisition, subject to the same or equivalent privacy protections.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">4. Security</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Data encrypted in transit (TLS 1.3) and at rest (AES-256).</li>
            <li>SOC 2 Type II compliant controls.</li>
            <li>Strict access controls and audit logs.</li>
            <li>Annual penetration testing.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">5. Retention</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>We delete active data within 30 days of cancellation (backups retained for up to 90 days).</li>
            <li>Financial records are retained for 7 years for compliance and may be anonymized thereafter.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">6. Your Rights</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Access: request a data export at any time.</li>
            <li>Delete: request erasure of your data (subject to legal retention requirements).</li>
            <li>Correct: update inaccurate information.</li>
            <li>Opt-Out: unsubscribe from marketing emails at any time.</li>
          </ul>
          <p>We comply with GDPR and CCPA where applicable. Contact privacy@profitwise.com for requests.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">7. International Transfers</h2>
          <p>
            Data may be stored in the US or EU. Singapore operations rely on Standard Contractual Clauses and equivalent
            safeguards for cross-border transfers.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">8. Children&apos;s Privacy</h2>
          <p>Our Services are not directed to children under 16, and we do not knowingly collect their data.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">9. Changes</h2>
          <p>
            We may update this Privacy Policy from time to time. Continued use of the Services after updates constitutes
            acceptance of the revised policy.
          </p>
        </section>

        <section className="space-y-1 text-sm md:text-base">
          <p>
            Contact:{" "}
            <a href="mailto:krishna@profitwise.app" className="underline">
              krishna@profitwise.app
            </a>
          </p>
          <p>Krishna Bhatnagar, Co-Founder &amp; Chief Technology Officer, ProfitWise Inc.</p>
        </section>
      </main>
    </div>
  )
}

