"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOutAction } from "@/app/signout-action";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BracketsCurly,
  CaretDown,
  ChatCircleDots,
  Command,
  CreditCard,
  CrownSimple,
  Gauge,
  Key,
  Keyboard,
  List,
  MagnifyingGlass,
  Moon,
  Robot,
  SignOut,
  SlidersHorizontal,
  Sun,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useShortcuts, SHORTCUT_HELP_ITEMS } from "@/lib/shortcuts";
import { useEscapeAction } from "../lib/escape-actions";

const productLinks = [
  { href: "/chat", label: "Hive", icon: CrownSimple },
  { href: "/build", label: "Council runs", icon: BracketsCurly },
];
const settingLinks = [
  { href: "/settings/general", label: "General", icon: SlidersHorizontal },
  { href: "/settings/providers", label: "Providers", icon: Robot },
  { href: "/settings/api-keys", label: "API keys", icon: Key },
  { href: "/settings/usage", label: "Usage", icon: Gauge },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/admin/beta", label: "Beta admin", icon: UsersThree },
];

export function AppShell({
  title,
  email,
  children,
}: {
  title: string;
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const commandMenu = useRef<HTMLElement>(null);
  const helpRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
  }, []);

  useShortcuts([
    {
      id: "toggle-palette",
      label: "Command palette",
      keys: "\u2318+K",
      metaKey: true,
      key: "k",
      handler: () => setCommandOpen((current) => !current),
    },
    {
      id: "new-chat",
      label: "New chat",
      keys: "\u2318+Shift+O",
      metaKey: true,
      shiftKey: true,
      key: "o",
      handler: () => router.push("/chat"),
    },
    {
      id: "show-help",
      label: "Keyboard shortcuts",
      keys: "?",
      key: "?",
      handler: () => setHelpOpen(true),
    },
  ]);

  useEscapeAction(() => setHelpOpen(false), helpOpen, 80);
  useEscapeAction(() => setCommandOpen(false), commandOpen, 80);
  useEscapeAction(() => setMenu(false), menu, 40);

  useEffect(() => {
    if (!commandOpen || !commandMenu.current) return;
    const menuElement = commandMenu.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [
        ...menuElement.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [commandOpen]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("hive-theme", next);
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new CustomEvent("hive-theme-change", { detail: next }));
  }

  const commands = [...productLinks, ...settingLinks].filter((item) =>
    item.label.toLowerCase().includes(commandQuery.trim().toLowerCase()),
  );

  return (
    <div className="app-root" data-menu={menu ? "open" : "closed"}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="app-layout">
        <aside className="app-rail" aria-label="Product navigation">
          <div className="app-brand">
            <Link
              className="brand-lockup"
              href="/"
              aria-label="HIVE Cloud home"
            >
              <span className="brand-mark" aria-hidden="true">
                H
              </span>
              <span className="brand-name">HIVE</span>
            </Link>
            <button
              className="icon-button mobile-menu"
              aria-label="Close navigation"
              onClick={() => setMenu(false)}
            >
              <X size={20} />
            </button>
          </div>
          <nav className="rail-section" aria-label="Workspace">
            <span className="rail-label">Workspace</span>
            {productLinks.map(({ href, label, icon: Icon }) => (
              <Link
                className="rail-link"
                data-label={label}
                data-active={pathname === href}
                href={href}
                key={href}
                onClick={() => setMenu(false)}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <nav className="rail-section" aria-label="Control plane">
            <span className="rail-label">Control plane</span>
            {settingLinks.map(({ href, label, icon: Icon }) => (
              <Link
                className="rail-link"
                data-label={label}
                data-active={pathname === href}
                href={href}
                key={href}
                onClick={() => setMenu(false)}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="rail-spacer" />
          <details className="rail-account">
            <summary aria-label={`Account menu for ${email}`}>
              <span className="account-avatar" aria-hidden="true">
                {email.slice(0, 1).toUpperCase()}
              </span>
              <span className="account-copy">
                <strong>{email}</strong>
                <small>Personal tenant</small>
              </span>
              <CaretDown size={14} aria-hidden="true" />
            </summary>
            <div className="account-popover">
              <div>
                <strong>{email}</strong>
                <span>Personal tenant</span>
              </div>
              <Link href="/settings/providers" onClick={() => setMenu(false)}>
                <SlidersHorizontal size={16} /> Provider control
              </Link>
              <form action={signOutAction}>
                <button
                  className="signout-button"
                  type="submit"
                  data-testid="sign-out"
                  aria-label="Sign out"
                >
                  <SignOut size={16} aria-hidden="true" /> Sign out
                </button>
              </form>
            </div>
          </details>
        </aside>
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
        <main id="main-content" className="app-main">
          <header className="app-topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className="icon-button mobile-menu"
                aria-label="Open navigation"
                onClick={() => setMenu(true)}
              >
                <List size={21} />
              </button>
              <div className="topbar-title">
                <h1>{title}</h1>
                <span>Queen-routed workspace</span>
              </div>
            </div>
            <div className="topbar-meta">
              <button
                className="command-trigger"
                aria-label="Open command menu"
                onClick={() => setCommandOpen(true)}
              >
                <MagnifyingGlass size={14} />
                <span>Navigate</span>
                <kbd>
                  <Command size={11} />K
                </kbd>
              </button>
              <span className="router-pill router-status">
                <CrownSimple size={14} weight="fill" aria-hidden="true" />
                <span>Queen online</span>
                <i aria-hidden="true" />
              </span>
              <button
                className="icon-button"
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                onClick={toggleTheme}
              >
                {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
              </button>
            </div>
          </header>
          {children}
        </main>
      </div>
      {commandOpen && (
        <div className="command-layer">
          <button
            className="command-backdrop"
            aria-label="Close command menu"
            onClick={() => setCommandOpen(false)}
          />
          <section
            ref={commandMenu}
            className="command-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Navigate HIVE"
          >
            <div className="command-search">
              <MagnifyingGlass size={17} />
              <input
                autoFocus
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                aria-label="Search HIVE surfaces"
                placeholder="Find a HIVE surface"
              />
            </div>
            <div className="command-results">
              {commands.length === 0 ? (
                <p>No matching surface.</p>
              ) : (
                commands.map(({ href, label, icon: Icon }) => (
                  <Link
                    href={href}
                    key={href}
                    onClick={() => {
                      setCommandOpen(false);
                      setCommandQuery("");
                    }}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                    <ArrowRight size={14} />
                  </Link>
                ))
              )}
            </div>
            <footer>
              <span>Navigate</span>
              <kbd>Esc</kbd>
              <span>Close</span>
            </footer>
          </section>
        </div>
      )}
      {helpOpen && (
        <div className="command-layer">
          <button
            className="command-backdrop"
            aria-label="Close keyboard shortcuts"
            onClick={() => setHelpOpen(false)}
          />
          <section
            ref={helpRef}
            className="command-menu help-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
          >
            <div className="help-dialog-head">
              <Keyboard size={20} aria-hidden="true" />
              <h2>Keyboard shortcuts</h2>
            </div>
            <div className="help-dialog-list">
              {SHORTCUT_HELP_ITEMS.map((item) => (
                <div className="help-dialog-row" key={item.id}>
                  <span>{item.label}</span>
                  <kbd>{item.keys}</kbd>
                </div>
              ))}
            </div>
            <footer>
              <span>
                Press <kbd>Esc</kbd> to close
              </span>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
