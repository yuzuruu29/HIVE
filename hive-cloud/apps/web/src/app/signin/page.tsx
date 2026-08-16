import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { ArrowRight, EnvelopeSimple, GithubLogo, GoogleLogo } from "@phosphor-icons/react/dist/ssr";
import { signIn } from "@/auth";
import { betaBypassEnabled } from "@/lib/beta-bypass";
import { submitLocalSignIn } from "./signin-action";

export const dynamic = "force-dynamic";

type SignInSearchParams = {
  check?: string;
  email?: string;
  error?: string;
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<SignInSearchParams> }) {
  const params = await searchParams;
  const bypass = betaBypassEnabled();
  const githubEnabled = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const resendEnabled = Boolean(process.env.AUTH_RESEND_KEY);
  const mailpitEnabled = process.env.NODE_ENV !== "production" && Boolean(process.env.MAILPIT_API_URL);
  const errorMessage = params.error === "invalid_email"
    ? "Enter a valid email address to request a sign-in link."
    : params.error === "signin_failed"
      ? "We couldn't send a sign-in link. Check the local services and try again."
      : undefined;

  return (
    <main className="signin-page">
      <section className="signin-card">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark" aria-hidden="true">H</span>
          <span className="brand-name">HIVE</span>
        </Link>
        <h1>Enter HIVE Cloud</h1>
        <p>{params.check ? "Check your email for a passwordless sign-in link." : "Beta access requires an approved email. Choose a verified OAuth account or a magic link."}</p>
        {errorMessage && <p className="form-message" role="alert">{errorMessage}</p>}
        <div className="signin-actions">
          {bypass && <Link className="button button-primary" href="/chat">Open local beta preview <ArrowRight size={16} /></Link>}
          {githubEnabled && (
            <form action={async () => { "use server"; await signIn("github", { redirectTo: "/chat" }); }}>
              <button className="button button-secondary" style={{ width: "100%" }}><GithubLogo size={18} /> Continue with GitHub</button>
            </form>
          )}
          {googleEnabled && (
            <form action={async () => { "use server"; await signIn("google", { redirectTo: "/chat" }); }}>
              <button className="button button-secondary" style={{ width: "100%" }}><GoogleLogo size={18} /> Continue with Google</button>
            </form>
          )}
          {resendEnabled && (
            <form action={async (formData) => { "use server"; await signIn("resend", { email: formData.get("email"), redirectTo: "/chat" }); }}>
              <div className="field">
                <label htmlFor="signin-email">Passwordless email</label>
                <input className="input" id="signin-email" name="email" type="email" defaultValue={params.email} required autoComplete="email" />
              </div>
              <button className="button button-secondary" style={{ width: "100%", marginTop: 10 }}><EnvelopeSimple size={18} /> Email a sign-in link</button>
            </form>
          )}
          {mailpitEnabled && (
            <form action={async (formData) => {
              "use server";
              await submitLocalSignIn(formData, {
                signIn,
                rethrow: unstable_rethrow,
                redirect,
                logError: (message, details) => console.error(message, details),
              });
            }}>
              <div className="field">
                <label htmlFor="signin-email-local">Passwordless email</label>
                <input className="input" id="signin-email-local" name="email" type="email" defaultValue={params.email} required autoComplete="email" />
              </div>
              <button className="button button-secondary" style={{ width: "100%", marginTop: 10 }}><EnvelopeSimple size={18} /> Send a local sign-in link</button>
            </form>
          )}
        </div>
        <p className="form-message" style={{ marginTop: 18 }}>OAuth email addresses must be verified and match an approved beta invitation.</p>
      </section>
    </main>
  );
}
