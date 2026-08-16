"use client";

import { BracketsCurly, CaretRight, ChatCircleDots, CheckCircle, CrownSimple, Globe, MagnifyingGlass, ShieldCheck, Sparkle } from "@phosphor-icons/react";
import { chatModeDetails } from "./chat-mode-config";
import { HiveCoreMark, type ChatMode } from "./chat-interface";

function modeIcon(mode: ChatMode) {
  if (mode === "build") return <BracketsCurly size={22} />;
  if (mode === "research") return <Globe size={22} />;
  return <ChatCircleDots size={22} />;
}

export function HiveWelcomeState({ mode, onModeChange, onSuggestion, composer }: { mode: ChatMode; onModeChange: (mode: ChatMode) => void; onSuggestion: (prompt: string) => void; composer: React.ReactNode }) {
  return (
    <section className="hive-welcome" aria-labelledby="hive-welcome-title">
      <div className="hive-welcome-intro">
        <div className="hive-welcome-copy">
          <HiveCoreMark />
          <div><span className="hive-eyebrow">Queen-led orchestration</span><h1 id="hive-welcome-title">Give the Hive an outcome.</h1></div>
          <p>The Queen assigns specialist models, runs independent checks, and returns one traceable result.</p>
        </div>
        <section className="orchestration-preview" aria-label="Default Queen Council choreography">
          <header><span>Default run</span><strong>7 routed calls</strong></header>
          <div className="orchestration-flow">
            <div className="orchestration-node queen-node"><span><CrownSimple size={15} weight="fill" /></span><div><strong>Queen</strong><small>Defines success</small></div></div>
            <i className="flow-line" aria-hidden="true" />
            <div className="orchestration-sequence">
              <div className="orchestration-node"><span><MagnifyingGlass size={14} /></span><div><strong>Scout</strong><small>Maps evidence</small></div></div>
              <div className="orchestration-node"><span><Sparkle size={14} /></span><div><strong>Planner + Builder</strong><small>Plans and proposes</small></div></div>
            </div>
            <div className="orchestration-branch" aria-label="Independent checks run in parallel">
              <span>Independent checks</span>
              <div><div className="orchestration-node"><span><CheckCircle size={14} /></span><div><strong>Validator</strong><small>Static evidence</small></div></div><div className="orchestration-node"><span><ShieldCheck size={14} /></span><div><strong>Reviewer</strong><small>Risk verdict</small></div></div></div>
            </div>
            <i className="flow-line" aria-hidden="true" />
            <div className="orchestration-node queen-node"><span><CrownSimple size={15} weight="fill" /></span><div><strong>Queen synthesis</strong><small>One final result</small></div></div>
          </div>
          <footer><span>Route chosen per stage</span><span>Fallbacks disclosed</span></footer>
        </section>
      </div>
      <div className="hive-welcome-command">
        <div className="mode-selector" role="group" aria-label="Choose how HIVE should help">
          {(Object.keys(chatModeDetails) as ChatMode[]).map((item) => <button className="mode-card" type="button" aria-pressed={mode === item} data-selected={mode === item} onClick={() => onModeChange(item)} key={item}><span className="mode-card-icon">{modeIcon(item)}</span><span><strong>{chatModeDetails[item].title}</strong><small>{chatModeDetails[item].description}</small></span><i aria-hidden="true" /></button>)}
        </div>
        <div className="welcome-composer">{composer}</div>
        <div className="suggestion-panel" aria-live="polite">
          <div className="suggestion-heading"><strong>Common starting points</strong><span>{chatModeDetails[mode].title}</span></div>
          <div className="suggestion-list">{chatModeDetails[mode].suggestions.map((suggestion) => <button type="button" onClick={() => onSuggestion(suggestion)} key={suggestion}><span>{suggestion}</span><CaretRight size={14} /></button>)}</div>
        </div>
      </div>
    </section>
  );
}
