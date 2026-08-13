"use client"

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-black text-foreground font-sans">
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 md:py-16">
        <h1 className="text-2xl md:text-3xl font-semibold">Terms &amp; Conditions</h1>
        <p className="text-xs text-muted-foreground">Effective Date: February 23, 2026</p>

        <p>
          Welcome to ProfitWise Inc. (&quot;ProfitWise&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;). These Terms &amp;
          Conditions (&quot;Terms&quot;) govern your access to and use of our website, AI accounting services, and related
          products (collectively, the &quot;Services&quot;). By signing up, connecting accounts, or using the Services, you
          agree to these Terms.
        </p>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">1. Services Overview</h2>
          <p>
            ProfitWise provides AI-powered bookkeeping, reconciliation, reporting, invoice management, and financial
            advisory services for small and medium businesses (&quot;SMBs&quot;). Our AI agent &quot;Wise&quot; automates financial
            workflows while licensed accountants provide review and compliance support.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">2. Eligibility</h2>
          <p>
            You must be 18+ years old, legally authorized to enter contracts, and operate a legitimate business.
            Services are available only to businesses, not individuals for personal use.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">3. Account &amp; Onboarding</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Create an account with accurate business information.</li>
            <li>
              Connect authorized bank accounts, accounting software (QuickBooks, Xero, FreshBooks), email, chat apps,
              and document storage.
            </li>
            <li>
              You grant ProfitWise permission to access connected accounts solely for providing Services. You are
              responsible for maintaining account security and notifying us of unauthorized access.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">4. Pricing &amp; Payments</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>Plans: Starter ($299/mo), Growth ($799/mo), Enterprise ($1,499+/mo).</li>
            <li>Billed monthly or annually (15% discount). No refunds except 30-day money-back guarantee.</li>
            <li>Payments via credit card or ACH. Overdue accounts may be suspended.</li>
            <li>Prices exclude taxes; you pay applicable sales/use tax.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">5. 30-Day Money-Back Guarantee</h2>
          <p>
            Full refund within 30 days if Wise hasn&apos;t reconciled transactions and chased invoices by Day 15. Contact{" "}
            <a href="mailto:support@profitwise.com" className="underline">
              support@profitwise.com
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">6. Cancellation</h2>
          <p>
            Cancel anytime via dashboard. No refunds for partial months. Annual plans are pro-rated upon cancellation.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">7. Data Ownership &amp; Usage</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm md:text-base">
            <li>You own your data. We do not claim ownership of your financial records, invoices, or business documents.</li>
            <li>We process data only to deliver Services (reconciliation, reporting, collections).</li>
            <li>You may export data anytime in CSV/PDF format.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">8. Accuracy &amp; Liability</h2>
          <p>
            Services use AI and human review for accuracy, but we are not liable for financial errors, tax penalties, or
            business losses. Always verify critical data. Consult your CPA for tax advice.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">9. Third-Party Integrations</h2>
          <p>
            We integrate with banks (via Plaid), accounting software, Gmail/Slack/WhatsApp, and Drive/Dropbox. You agree
            to their terms. We are not responsible for third-party outages or changes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">10. Confidentiality</h2>
          <p>We protect your financial data per our Privacy Policy. You agree not to share other ProfitWise users&apos; data.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">11. Termination</h2>
          <p>
            We may suspend or terminate access for violation of Terms, non-payment, or illegal use. You may terminate
            anytime.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">12. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, ProfitWise is provided &quot;AS IS&quot; with no warranties. Our maximum
            liability is limited to 12 months of fees paid, and we are not liable for consequential damages.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">13. Governing Law</h2>
          <p>
            These Terms are governed by the laws of Delaware, USA. Disputes will be resolved via binding arbitration in
            Singapore, taking your location into consideration.
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

