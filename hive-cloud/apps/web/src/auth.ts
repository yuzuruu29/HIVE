import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import type { EmailConfig } from "next-auth/providers/email";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import {
  accounts,
  createDatabase,
  sessions,
  users,
  verificationTokens,
} from "@hive-cloud/database";
import { betaBypassEnabled } from "@/lib/beta-bypass";
import { emailIsInvited, provisionInvitedUser } from "@/auth-access";

const database = process.env.DATABASE_URL ? createDatabase(process.env.DATABASE_URL) : undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function localMailpitProvider(endpoint: string, from: string): EmailConfig {
  return {
    id: "mailpit",
    type: "email",
    name: "Local email",
    from,
    maxAge: 15 * 60,
    async sendVerificationRequest({ identifier, url }) {
      const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      const fromEmail = match?.[2] ?? from;
      const fromName = match?.[1] || "HIVE";
      const host = new URL(url).host;
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: identifier }],
          Subject: `Sign in to ${host}`,
          Text: `Sign in to HIVE Cloud:\n${url}\n\nThis link expires in 15 minutes.`,
          HTML: `<p>Sign in to HIVE Cloud:</p><p><a href="${escapeHtml(url)}">Continue to ${escapeHtml(host)}</a></p><p>This link expires in 15 minutes.</p>`,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Local email capture returned HTTP ${response.status}.`);
    },
  };
}

const providers = [
  ...(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET ? [GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET })] : []),
  ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? [Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })] : []),
  ...(process.env.AUTH_RESEND_KEY ? [Resend({ apiKey: process.env.AUTH_RESEND_KEY, from: process.env.EMAIL_FROM || "HIVE <access@example.com>" })] : []),
  ...(process.env.NODE_ENV !== "production" && process.env.MAILPIT_API_URL
    ? [localMailpitProvider(process.env.MAILPIT_API_URL, process.env.EMAIL_FROM || "HIVE <access@example.com>")]
    : []),
];

async function invited(email: string): Promise<boolean> {
  if (betaBypassEnabled()) return true;
  if (!database) return false;
  return emailIsInvited(database.db, email);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  ...(database ? {
    adapter: DrizzleAdapter(database.db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
  } : {}),
  session: { strategy: database ? "database" : "jwt", maxAge: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  providers,
  pages: { signIn: "/signin", verifyRequest: "/signin?check=email" },
  callbacks: {
    async signIn({ user, profile }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      if (profile && "email_verified" in profile && profile.email_verified === false) return false;
      return invited(email);
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, user, token }) {
      if (session.user) session.user.id = user?.id || token.sub || "";
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (!database || !user.id || !user.email) return;
      await provisionInvitedUser(database.db, { id: user.id, email: user.email, name: user.name });
    },
  },
});
