import { useEffect, useMemo } from "react";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { CHAT_ROLE_CARDS } from "../../../../../src/chat/roles";
import type { ChatRouteInfo } from "../../state";

export interface WelcomeProps {
  repositoryRoot: string | null;
  routes: Record<string, ChatRouteInfo>;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onPickRole: (role: string) => void;
  onPickSuggestion: (text: string) => void;
}

const BEE_ART = "  ___   ___\n /   \\ /   \\\n \\___/ \\___/\n   \\___/";

function routeChip(routes: Record<string, ChatRouteInfo>, role: string): string {
  const route = routes[role];
  return route ? `${route.providerId}/${route.model}` : "route unresolved";
}

/** Empty-state welcome: HIVE wordmark, persona cards with route chips, starter prompts. */
export function Welcome({ repositoryRoot, routes, send, onPickRole, onPickSuggestion }: WelcomeProps) {
  const repoName = repositoryRoot ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "project" : "project";

  // Resolve the trust chips once per mount — cheap BYOK registry reads.
  useEffect(() => {
    for (const role of ["auto", ...CHAT_ROLE_CARDS.map((card) => card.slug)]) {
      void send({ type: "chat.route", input: { role } });
    }
  }, []);

  const suggestions = useMemo(
    () => [
      `Explain the architecture of ${repoName}`,
      `Draft a refactoring plan for ${repoName}`,
      `Review the trickiest module in ${repoName} for bugs`,
    ],
    [repoName],
  );

  return (
    <div className="chat-welcome anim-in">
      <pre className="welcome-bee" aria-hidden="true">{BEE_ART}</pre>
      <strong className="welcome-title">HIVE Chat</strong>
      <span className="welcome-sub">Pick a persona, or just start typing below.</span>

      <ul className="persona-grid" aria-label="Personas">
        <li>
          <button type="button" className="persona-card anim-in" onClick={() => onPickRole("auto")}>
            <span className="persona-name">Auto</span>
            <span className="persona-desc">Classifies each message and picks the right specialist.</span>
            <span className="route-chip">[route] {routeChip(routes, "auto")}</span>
          </button>
        </li>
        {CHAT_ROLE_CARDS.map((card) => (
          <li key={card.slug}>
            <button type="button" className="persona-card anim-in" onClick={() => onPickRole(card.slug)}>
              <span className="persona-name">{card.label}</span>
              <span className="persona-desc">{card.description}</span>
              <span className="route-chip">[route] {routeChip(routes, card.slug)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="prompt-starters" aria-label="Suggested first prompts">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" className="prompt-starter-chip" onClick={() => onPickSuggestion(suggestion)}>
            <span>&gt; {suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
