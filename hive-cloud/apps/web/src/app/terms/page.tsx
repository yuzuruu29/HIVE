import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <main className="legal-shell">
      <nav className="site-nav" aria-label="Primary navigation"><Link className="brand-lockup" href="/"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link><div className="nav-actions"><Link className="button button-secondary" href="/pricing">Pricing</Link><Link className="button button-primary" href="/signin">Sign in</Link></div></nav>
      <article className="legal-document">
        <p className="section-kicker">Beta terms draft · July 19, 2026</p><h1>Terms for the hosted beta</h1><div className="legal-warning">These beta terms are not production legal advice. Keep PayPal in Sandbox until jurisdiction, tax, refund, support, and consumer-law review is complete.</div>
        <section><h2>The service</h2><p>HIVE Cloud is an AI workspace and routing service. Model output can be incomplete or wrong. Build and Council artifacts must clearly state whether execution actually ran; you remain responsible for reviewing output before using it.</p></section>
        <section><h2>Your providers and content</h2><p>You must have the right to submit your content and use any provider key you connect. Do not use HIVE to violate law, provider rules, intellectual-property rights, or system security.</p></section>
        <section><h2>Hosted plans and credits</h2><p>Community includes a one-time promotional credit grant. Paid plans add managed credits after PayPal reports a settled subscription payment. BYOK and self-hosted provider costs are paid directly by you and do not consume HIVE managed credits.</p></section>
        <section><h2>Payment and cancellation</h2><p>PayPal is the payment processor. HIVE verifies subscription, order, amount, currency, and capture records on the server. Cancellation stops future renewal while access continues through the paid period reported by PayPal. A live operator must publish the final refund policy before accepting real payments.</p></section>
        <section><h2>Availability</h2><p>The hackathon beta may change, pause, or remove features. Rate limits, model availability, and upstream provider behavior can change. Managed routing fails closed when pricing, credit, or platform-spend controls are unavailable.</p></section>
        <section><h2>Open source</h2><p>The repository is licensed under AGPL-3.0. The open-source license governs use of the code; these hosted-service terms govern use of an operator’s deployment.</p></section>
      </article>
    </main>
  );
}
