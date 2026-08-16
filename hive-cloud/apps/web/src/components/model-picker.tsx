"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowClockwise, CaretDown, CaretUp, CrownSimple, Eye, MagnifyingGlass, Robot, SlidersHorizontal, Warning, Wrench, X } from "@phosphor-icons/react";
import type { HiveModelCatalogEntry } from "@hive-cloud/contracts";
import { useEscapeAction } from "../lib/escape-actions";

type PresentationMode = "popover" | "dialog" | "sheet";

function formatModelName(id: string, displayName?: string): string {
  if (id === "hive-0.1") return "HIVE Auto";
  if (displayName) return displayName;
  return ((id.includes("/") ? id.split("/")[1] : id) || id).split(/[-_]/).map((word) => {
    const lower = word.toLowerCase();
    if (["70b", "8b", "7b", "3b", "byok"].includes(lower)) return lower.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function usePresentationMode(): PresentationMode {
  const [mode, setMode] = useState<PresentationMode>("popover");
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 639px)");
    const tablet = window.matchMedia("(min-width: 640px) and (max-width: 1199px)");
    const update = () => setMode(mobile.matches ? "sheet" : tablet.matches ? "dialog" : "popover");
    update();
    mobile.addEventListener?.("change", update); tablet.addEventListener?.("change", update);
    return () => { mobile.removeEventListener?.("change", update); tablet.removeEventListener?.("change", update); };
  }, []);
  return mode;
}

function ModelCostBadge({ costClass, managed, model }: { costClass?: string; managed?: boolean; model: string }) {
  if (!managed) return null;

  const isCheap = model.includes("mini") || model.includes("haiku");
  const isMid = model.includes("sonnet") || model.includes("4.1");
  const estimate = isCheap ? "~1-3 credits" : isMid ? "~3-8 credits" : "~5-15 credits";

  return (
    <span className="model-cost-badge" title={`Estimated credits per request: ${estimate}`}>
      {estimate}
    </span>
  );
}

export function ModelPicker({ models, selectedId, onChange, disabled, loading, error, onRefresh }: {
  models: HiveModelCatalogEntry[]; selectedId: string; onChange: (id: string) => void; disabled?: boolean; loading?: boolean; error?: boolean; onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [coords, setCoords] = useState<React.CSSProperties>({});
  const mode = usePresentationMode();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEscapeAction(() => { setOpen(false); triggerRef.current?.focus(); }, open, 100);

  useEffect(() => setMounted(true), []);
  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (!open || mode !== "popover") return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect(); if (!rect) return;
      const above = rect.top >= 436;
      setCoords(above
        ? { bottom: window.innerHeight - rect.top + 10, right: Math.max(16, window.innerWidth - rect.right), maxHeight: Math.max(200, rect.top - 34) }
        : { top: rect.bottom + 10, right: Math.max(16, window.innerWidth - rect.right), maxHeight: Math.max(200, window.innerHeight - rect.bottom - 34) });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node) || pickerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open || mode === "popover") return;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const picker = pickerRef.current;
    const focusable = () => [...(picker?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    picker?.querySelector<HTMLInputElement>("input")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return; const items = focusable(); const first = items[0]; const last = items.at(-1); if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", trap); previousFocus?.focus(); };
  }, [mode, open]);

  const filtered = useMemo(() => models.filter((model) => model.id !== "hive-0.1" && (!query.trim() || `${model.displayName} ${model.id} ${model.provider}`.toLowerCase().includes(query.trim().toLowerCase()))), [models, query]);
  const options = useMemo(() => query ? filtered : [{ id: "hive-0.1" }, ...filtered], [filtered, query]);
  const selected = models.find((model) => model.id === selectedId);
  const unavailable = selectedId !== "hive-0.1" && !selected && !loading;
  const label = selectedId === "hive-0.1" ? "HIVE Auto" : formatModelName(selectedId, selected?.displayName);
  const badge = selectedId === "hive-0.1" ? "AUTO" : selected ? selected.costClass.toUpperCase() : "UNAVAILABLE";

  function choose(id: string) { onChange(id); setOpen(false); triggerRef.current?.focus(); }
  function handleKeyDown(event: React.KeyboardEvent) {
    if (!open && ["Enter", "ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); return; }
    if (!open || options.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => (value + 1) % options.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => (value - 1 + options.length) % options.length); }
    else if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setActiveIndex(options.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); const option = options[activeIndex]; if (option) choose(option.id); }
  }

  function option(model: HiveModelCatalogEntry, index: number) {
    const isSelected = model.id === selectedId;
    const cooling = Boolean(model.cooldownUntil && Date.parse(model.cooldownUntil) > Date.now());
    return <button ref={(element) => { optionRefs.current[index] = element; }} key={model.id} role="option" aria-selected={isSelected} className="model-picker-option" data-selected={isSelected} data-active={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(model.id)} title={`Raw ID: ${model.id}`}>
      <span className="model-picker-radio" aria-hidden="true">{isSelected && <i />}</span>
      <span className="model-picker-option-copy"><strong>{model.displayName}</strong><small>{model.provider} · {model.managed ? "Managed" : "BYOK"}</small></span>
      <ModelCostBadge costClass={model.costClass} managed={model.managed} model={model.model} />
      <span className="model-picker-option-meta">{model.vision && <span title="Supports vision input"><Eye size={12} /></span>}{model.tools && <span title="Supports tool execution"><Wrench size={12} /></span>}<small>{cooling ? "Cooling down" : "Ready"}</small></span>
    </button>;
  }

  const picker = <div ref={pickerRef} role="listbox" aria-label="Choose a model" className="model-picker-popover-container" data-mode={mode} style={mode === "popover" ? coords : undefined} onKeyDown={handleKeyDown}>
    <header className="model-picker-header"><div className="model-picker-heading"><CrownSimple size={16} weight="fill" /><strong>Choose a model</strong>{mode !== "popover" && <button type="button" className="model-picker-close-button" aria-label="Close model picker" onClick={() => setOpen(false)}><X size={18} /></button>}</div><p>Select HIVE Auto or pin a provider model.</p><label className="model-picker-search"><MagnifyingGlass size={14} /><span className="sr-only">Search models</span><input aria-label="Search models" placeholder="Search models…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear model search" onClick={() => setQuery("")}><X size={14} /></button>}</label></header>
    <div className="model-picker-list" aria-busy={loading}>
      {loading && <div className="model-picker-loading">{[0, 1, 2].map((item) => <span className="skeleton" key={item} />)}</div>}
      {error && <div className="model-picker-error" role="alert"><Warning size={24} /><strong>Model catalog unavailable</strong><span>Failed to fetch the routing list</span>{onRefresh && <button className="button button-primary" onClick={onRefresh}><ArrowClockwise size={13} /> Retry</button>}</div>}
      {!loading && !error && <div className="model-picker-groups">
        {!query && <section className="model-picker-group"><h3>HIVE ROUTING</h3><button ref={(element) => { optionRefs.current[0] = element; }} role="option" aria-selected={selectedId === "hive-0.1"} className="model-picker-option model-picker-option-auto" data-selected={selectedId === "hive-0.1"} data-active={activeIndex === 0} onMouseEnter={() => setActiveIndex(0)} onClick={() => choose("hive-0.1")}><span className="model-picker-radio" aria-hidden="true">{selectedId === "hive-0.1" && <i />}</span><span className="model-picker-option-copy"><strong>HIVE Auto</strong><small>Free-first balanced routing</small><em>Automatically chooses an eligible route · Ready</em></span><span className="model-picker-recommended">Recommended</span></button></section>}
        {filtered.length > 0 && <section className="model-picker-group"><h3>CONNECTED MODELS</h3><div className="model-picker-options">{filtered.map((model, index) => option(model, index + (query ? 0 : 1)))}</div></section>}
        {filtered.length === 0 && query && <div className="model-picker-empty"><strong>No connected models found</strong><span>Try another search or connect a provider.</span></div>}
      </div>}
    </div>
    <footer className="model-picker-footer">{onRefresh ? <button type="button" disabled={loading} onClick={onRefresh}><ArrowClockwise size={14} /> Refresh</button> : <span />}<Link href="/settings/providers" onClick={() => setOpen(false)}><SlidersHorizontal size={14} /> Manage providers</Link></footer>
  </div>;

  return <div className="model-picker" onKeyDown={handleKeyDown}>
    <button ref={triggerRef} type="button" disabled={disabled} aria-expanded={open} aria-haspopup="listbox" className="model-picker-trigger" data-open={open} onClick={() => !disabled && setOpen((value) => !value)}><span className="model-picker-trigger-main">{selectedId === "hive-0.1" ? <CrownSimple size={14} weight="fill" /> : <Robot size={14} />}<strong>{label}</strong></span><span className="model-picker-trigger-meta">{unavailable && <Warning size={13} weight="fill" />}<small className="model-picker-trigger-badge" data-unavailable={unavailable}>{badge}</small>{open ? <CaretUp size={12} /> : <CaretDown size={12} />}</span></button>
    {open && mounted && <>{mode !== "popover" && createPortal(<button type="button" className="model-picker-backdrop" aria-label="Close model picker" onClick={() => setOpen(false)} />, document.body)}{createPortal(picker, document.body)}</>}
  </div>;
}
