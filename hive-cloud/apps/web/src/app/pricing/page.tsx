import type { Metadata } from "next";
import Link from "next/link";
import { Check, GithubLogo } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Pricing", description: "HIVE Cloud hosted plans and self-hosting options." };

const plans = [
  {
    name: "Community",
    price: "Free",
    cadence: "forever",
    description: "For evaluating HIVE, connecting your own providers, and self-hosting.",
    features: ["50 one-time managed credits", "BYOK and open-model routing", "30 routed jobs per day", "2 Council runs", "AGPL-3.0 self-hosting", "Visible route receipts"],
    action: "Start free",
    featured: false,
  },
  {
    name: "Builder",
    price: "$15",
    cadence: "per month",
    description: "For individual builders who want managed models without configuring provider accounts.",
    features: ["600 managed credits each paid month", "Managed OpenAI and Anthropic", "100 routed jobs per day", "20 Council runs per month", "Build mode, uploads, and exports", "BYOK remains free"],
    action: "Choose Builder",
    featured: true,
  },
  {
    name: "Pro",
    price: "$39",
    cadence: "per month",
    description: "For heavier personal use, longer sessions, and more orchestration capacity.",
    features: ["1,600 managed credits each paid month", "Premium managed routes", "300 routed jobs per day", "75 Council runs per month", "Higher concurrency and file limits", "BYOK remains free"],
    action: "Choose Pro",
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <main className="pricing-shell">
      <nav className="site-nav" aria-label="Primary navigation">
        <Link className="brand-lockup" href="/"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link>
        <div className="nav-links"><Link href="/#router">Router</Link><Link href="/#modes">Chat + Build</Link><Link href="/pricing">Pricing</Link><a href="https://github.com/yuzuruu29/hive-cloud">Source</a></div>
        <div className="nav-actions"><Link className="button button-secondary" href="/signin">Sign in</Link><Link className="button button-primary" href="/signin">Start free</Link></div>
      </nav>

      <header className="pricing-hero"><p className="section-kicker">Hosted HIVE Cloud</p><h1>Pay for managed capacity.<br /><span>Keep your provider freedom.</span></h1><p>BYOK and self-hosted routes do not consume credits. Managed usage is metered from immutable provider price snapshots and shown on route receipts.</p></header>

      <section className="pricing-grid" aria-label="Plans">
        {plans.map((plan) => (
          <article className="pricing-card" data-featured={plan.featured} key={plan.name}>
            {plan.featured && <span className="pricing-badge">Best for builders</span>}
            <div><h2>{plan.name}</h2><p>{plan.description}</p></div>
            <div className="pricing-amount"><strong>{plan.price}</strong><span>{plan.cadence}</span></div>
            <ul>{plan.features.map((feature) => <li key={feature}><Check size={16} weight="bold" aria-hidden="true" />{feature}</li>)}</ul>
            <Link className={`button ${plan.featured ? "button-primary" : "button-secondary"}`} href="/signin">{plan.action}</Link>
          </article>
        ))}
      </section>

      <section className="pricing-explainer">
        <div><p className="section-kicker">Metering</p><h2>One credit is one cent of managed retail usage.</h2></div>
        <div className="pricing-faq-grid"><article><h3>What happens at zero?</h3><p>HIVE fails the managed route closed and keeps BYOK or open-model options available. Your conversations are not locked.</p></article><article><h3>How is cost calculated?</h3><p>Provider input and output tokens are priced from a dated snapshot, then the hosted managed rate is applied. The receipt records tokens and credits.</p></article><article><h3>Can I self-host?</h3><p>Yes. The full application is available under AGPL-3.0 and PayPal is optional in self-hosted mode.</p></article><article><h3>Can I buy more?</h3><p>Hosted users can add $10 or $30 credit packs from Billing. PayPal captures are verified server-side before credits are granted.</p></article></div>
      </section>

      <section className="source-cta"><div><GithubLogo size={28} aria-hidden="true" /><div><strong>Inspect the product you are trusting.</strong><span>Read the router, billing, and security boundaries in the open.</span></div></div><a className="button button-secondary" href="https://github.com/yuzuruu29/hive-cloud">View source</a></section>

      <footer className="site-footer"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">H</span><span>Hyper Intelligence for Verified Engineering</span></div><div className="footer-links"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="https://github.com/yuzuruu29/hive-cloud">Source</a></div></footer>
    </main>
  );
}
