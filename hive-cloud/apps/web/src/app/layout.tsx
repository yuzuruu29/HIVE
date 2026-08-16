import type { Metadata, Viewport } from "next";
import "@fontsource/silkscreen/400.css";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { Analytics } from "@/components/analytics";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "HIVE Cloud", template: "%s | HIVE Cloud" },
  description: "Chat, build, and route across open models with visible fallbacks, BYOK control, and verification.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_ORIGIN || "http://localhost:3000"),
  openGraph: {
    title: "One hive. Every open model.",
    description: "Transparent model routing and verified Build workflows from HIVE.",
    type: "website",
  },
};

export const viewport: Viewport = { colorScheme: "dark light", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f6f4f9" }, { media: "(prefers-color-scheme: dark)", color: "#08080b" }] };

const themeBootScript = `(function(){try{var s=localStorage.getItem('hive-theme');var t=s==='light'||s==='dark'?s:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;document.documentElement.dataset.astryxTheme='hive'}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.dataset.astryxTheme='hive'}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <body><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /><Providers>{children}<Analytics /></Providers></body>
    </html>
  );
}
