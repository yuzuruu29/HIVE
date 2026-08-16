import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="legal-shell">
      <nav className="site-nav" aria-label="Primary navigation"><Link className="brand-lockup" href="/"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link><div className="nav-actions"><Link className="button button-secondary" href="/pricing">Pricing</Link><Link className="button button-primary" href="/signin">Sign in</Link></div></nav>
      <article className="legal-document">
        <p className="section-kicker">Beta policy draft · July 19, 2026</p><h1>Privacy at HIVE Cloud</h1><div className="legal-warning">This is a plain-language beta disclosure, not a lawyer-approved production privacy policy. Live billing should remain disabled until the operator completes legal review.</div>
        <section><h2>What HIVE stores</h2><p>Hosted HIVE stores account identifiers, workspace membership, conversations, uploaded-file metadata, encrypted provider credentials, route receipts, usage records, and billing records needed to operate the service.</p></section>
        <section><h2>How prompts are processed</h2><p>Your request is sent only to the provider route selected for that request. If you use BYOK, HIVE resolves the encrypted credential on the server. Provider processing is also governed by that provider’s terms and privacy policy.</p></section>
        <section><h2>Payments</h2><p>PayPal processes payment credentials. HIVE stores PayPal order, capture, payer, and subscription identifiers, amounts, status, and idempotency evidence; it does not store card numbers.</p></section>
        <section><h2>Security and retention</h2><p>Tenant-scoped data is protected with database row-level security where applicable. Provider secrets are encrypted and never returned after creation. Deleted conversations follow the configured soft-delete and purge schedule. Operational logs are designed to exclude prompts and secrets.</p></section>
        <section><h2>Analytics and self-hosting</h2><p>Hosted deployments may use operator-configured product analytics and error reporting. Self-hosted operators control their own database, telemetry configuration, subprocessors, and retention.</p></section>
        <section><h2>Your choices</h2><p>You can use BYOK, remove provider connections, delete conversations, export transcripts, cancel a subscription, or run the AGPL-3.0 application yourself. A production operator must publish a support and data-rights contact before launch.</p></section>
      </article>
    </main>
  );
}
