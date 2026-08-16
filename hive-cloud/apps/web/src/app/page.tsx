import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CheckCircle, Code, Key, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import { Reveal } from "@/components/reveal";
import { RouteVisual } from "@/components/route-visual";
import { WaitlistForm } from "@/components/waitlist-form";

const roles = [
  ["Queen", "Locks the success contract", "ready"],
  ["Scout", "Ranks only relevant files", "ready"],
  ["Planner", "Bounds the implementation", "ready"],
  ["Builder", "Proposes a reviewable patch", "ready"],
  ["Validator", "Checks the result", "ready"],
  ["Reviewer", "Issues the final verdict", "ready"],
];

const differences = [
  ["Transparent routing", "See the provider, model, fallback path, latency, token usage, and managed cost behind every answer."],
  ["Provider sovereignty", "Use managed OpenAI and Anthropic capacity, encrypted BYOK credentials, local open models, or a public compatible endpoint."],
  ["Verified Build mode", "A visible Council plans, proposes, validates, and reviews instead of hiding the workflow in one completion."],
  ["Open source by default", "Run the AGPL-3.0 stack yourself. Hosted plans pay for managed capacity and continued product work—not access to your data."],
];

export default function LandingPage() {
  return (
    <main className="marketing">
      <nav className="site-nav" aria-label="Primary navigation">
        <Link className="brand-lockup" href="/" aria-label="HIVE Cloud home"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link>
        <div className="nav-links"><a href="#router">Router</a><a href="#modes">Chat + Build</a><Link href="/pricing">Pricing</Link><a href="#api">API</a></div>
        <div className="nav-actions"><Link className="button button-secondary" href="/signin">Sign in</Link><Link className="button button-primary" href="/signin">Start free</Link></div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <p className="hero-kicker">Open source. Provider-sovereign. Receipts included.</p>
          <h1>One hive.<br /><span>Every route visible.</span></h1>
          <p className="hero-subtitle">Chat and build across managed frontier models, your own keys, and open models—without losing sight of who answered, why HIVE chose it, or what it cost.</p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/signin">Start with 50 credits <ArrowRight size={17} weight="bold" aria-hidden="true" /></Link>
            <a className="button button-secondary" href="https://github.com/yuzuruu29/hive-cloud">View source</a>
          </div>
        </div>
        <div className="hero-media">
          <div className="hero-image-frame"><Image src="/images/hive-queen-network.webp" alt="Queen intelligence core coordinating a violet network of model routes" fill priority sizes="(max-width: 860px) 100vw, 55vw" /></div>
          <RouteVisual />
        </div>
      </section>

      <section className="provider-band" aria-label="Supported provider families">
        <div className="provider-band-inner">
          <p>Managed convenience and BYOK control share one transparent router.</p>
          {['OpenAI', 'Anthropic', 'OpenRouter', 'Groq', 'NVIDIA', 'Open models'].map((provider) => <span className="provider-name" key={provider}>{provider}</span>)}
        </div>
      </section>

      <section className="marketing-section router-story" id="router">
        <div className="router-story-copy"><p className="section-kicker">HIVE 0.1</p><h2>A router that shows its work.</h2><p>Capability comes first. HIVE then weighs health, cost class, reliability, quality, and latency before it chooses—and records the decision.</p></div>
        <Reveal className="routing-map">
          <div className="routing-map-row"><div className="routing-node"><strong>Your request</strong><span>Context, files, tools, and route preference</span></div><div className="routing-arrow" aria-hidden="true">›</div><div className="routing-node"><strong>Capability gate</strong><span>Routes that cannot satisfy the request are removed</span></div></div>
          <div className="routing-map-row"><div className="routing-node"><strong>Free-first score</strong><span>BYOK, managed balance, health, quality, quota, and latency</span></div><div className="routing-arrow" aria-hidden="true">›</div><div className="routing-node"><strong>Safe fallback</strong><span>Fallback happens only before the first streamed token</span></div></div>
          <div className="routing-map-row"><div className="routing-node routing-receipt"><strong>Route receipt</strong><span>Provider, model, fallback, tokens, latency, and cost</span></div><div className="routing-arrow" aria-hidden="true">›</div><div className="routing-node"><strong>Your answer</strong><span>OpenAI-compatible output through one HIVE API key</span></div></div>
        </Reveal>
      </section>

      <section className="marketing-section" id="modes">
        <h2>Talk through it. Build with proof.</h2><p>Chat stays fast and familiar. Build exposes the engineering workflow behind the result.</p>
        <div className="mode-grid">
          <Reveal className="mode-panel"><h3>Verified Build</h3><p>Give HIVE a bounded objective and context. The Council produces a plan, proposed work, validation evidence, and review.</p><div className="mode-transcript">{roles.map(([role, task, state]) => <div className="role-row" key={role}><span>{role}</span><span>{task}</span><span>{state}</span></div>)}</div></Reveal>
          <Reveal className="mode-panel"><h3>General Chat</h3><p>Stream answers, attach scanned context, search with citations, branch prompts, and inspect the route behind each response.</p><div className="mode-transcript"><div className="role-row"><span>Files</span><span>Images, PDF, text, and code</span><span>ready</span></div><div className="role-row"><span>Models</span><span>Managed, BYOK, and open routes</span><span>ready</span></div><div className="role-row"><span>Receipts</span><span>Usage and routing evidence</span><span>ready</span></div></div></Reveal>
        </div>
      </section>

      <section className="marketing-section"><h2>Different by design.</h2><p>HIVE combines a serious workspace, a transparent router, and an inspectable orchestration system without taking away provider choice.</p><div className="difference-layout">{differences.map(([title, body]) => <Reveal className="difference-item" key={title}><h3>{title}</h3><p>{body}</p></Reveal>)}</div></section>

      <section className="marketing-section api-section" id="api">
        <div><p className="section-kicker">OpenAI-compatible API</p><h2>Point your client at HIVE.</h2><p>Keep the interface you already use. Change the base URL, use a reveal-once HIVE key, and select <code>hive-0.1</code>.</p></div>
        <Reveal className="code-window"><div className="code-window-head"><span>chat-completion.ts</span><span>streaming</span></div><pre><code>{`import OpenAI from "openai";

const hive = new OpenAI({
  baseURL: process.env.HIVE_BASE_URL,
  apiKey: process.env.HIVE_API_KEY,
});

const stream = await hive.chat.completions.create({
  model: "hive-0.1",
  stream: true,
  messages: [{ role: "user", content: "Review this plan." }],
});`}</code></pre></Reveal>
      </section>

      <section className="marketing-section" id="privacy"><Reveal className="privacy-block"><h2>Your providers stay yours.</h2><p>Credentials are encrypted, never returned, and resolved only for the request that needs them. HIVE does not train on your conversations.</p><div className="hero-actions"><span className="button button-secondary"><Key size={17} aria-hidden="true" /> Reveal-once keys</span><span className="button button-secondary"><ShieldCheck size={17} aria-hidden="true" /> Tenant isolation</span><span className="button button-secondary"><Code size={17} aria-hidden="true" /> AGPL-3.0 source</span></div></Reveal></section>

      <section className="marketing-section waitlist-block" id="waitlist">
        <div><p className="section-kicker">Hosted beta</p><h2>Bring your model stack into one hive.</h2><p>Start free, bring your own keys, or upgrade for managed capacity. Join the beta list if hosted access is still gated.</p><p className="form-message" style={{ marginTop: 20 }}><CheckCircle size={16} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-3px', marginRight: 7 }} />Self-hosting remains available without a subscription.</p></div>
        <WaitlistForm />
      </section>

      <footer className="site-footer">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">H</span><span>Hyper Intelligence for Verified Engineering</span></div>
        <div className="footer-links"><a href="https://github.com/yuzuruu29/hive-cloud">Source</a><Link href="/pricing">Pricing</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
      </footer>
    </main>
  );
}
