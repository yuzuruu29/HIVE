import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "../shell/icons";

export interface ConfiguredModelOption {
  providerId: string;
  providerName: string;
  model: string;
}

export interface ConfiguredModelPickerProps {
  options: ConfiguredModelOption[];
  selectedModel?: { providerId: string; model: string } | null;
  onSelectModel?: (choice: ConfiguredModelOption) => void;
  onOpenSettings?: () => void;
  onOpenModelPicker?: () => void;
  label?: string;
  placeholder?: string;
  className?: string;
  resetKey?: string;
}

export function ConfiguredModelPicker({
  options,
  selectedModel,
  onSelectModel,
  onOpenSettings,
  onOpenModelPicker,
  label = "Select model",
  placeholder = "Select model",
  className,
  resetKey,
}: ConfiguredModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const groups = options.reduce<Array<{ providerId: string; providerName: string; models: ConfiguredModelOption[] }>>((result, option) => {
    const group = result.find((item) => item.providerId === option.providerId);
    if (group) group.models.push(option);
    else result.push({ providerId: option.providerId, providerName: option.providerName, models: [option] });
    return result;
  }, []);
  const orderedOptions = groups.flatMap((group) => group.models);
  const selectedIndex = orderedOptions.findIndex((option) => option.providerId === selectedModel?.providerId && option.model === selectedModel?.model);
  const selected = orderedOptions[selectedIndex];
  const currentIndex = Math.min(activeIndex, orderedOptions.length - 1);
  const isOpen = open && orderedOptions.length > 0;
  const visible = isOpen && position !== null;

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function containsTarget(target: EventTarget | null): boolean {
    return target instanceof Node && Boolean(rootRef.current?.contains(target) || popupRef.current?.contains(target));
  }

  function focusAfterTrigger(): void {
    const controls = [...document.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
      .filter((node) => {
        if (node.tabIndex < 0 || node.matches(":disabled") || popupRef.current?.contains(node)) return false;
        for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
          const style = window.getComputedStyle(ancestor);
          if (ancestor.hidden || ancestor.inert || style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      })
      .sort((left, right) => (left.tabIndex || Number.MAX_SAFE_INTEGER) - (right.tabIndex || Number.MAX_SAFE_INTEGER));
    const triggerIndex = triggerRef.current ? controls.indexOf(triggerRef.current) : -1;
    const next = controls[triggerIndex + 1] ?? controls[0] ?? triggerRef.current;
    closeMenu();
    next?.focus();
  }

  function openMenu(index = selectedIndex >= 0 ? selectedIndex : 0): void {
    if (!orderedOptions.length) {
      (onOpenModelPicker ?? onOpenSettings)?.();
      return;
    }
    setActiveIndex(index);
    setOpen(true);
  }

  function selectOption(option: ConfiguredModelOption): void {
    closeMenu(true);
    onSelectModel?.(option);
  }

  useEffect(() => { setOpen(false); }, [resetKey]);
  useEffect(() => { if (!options.length) setOpen(false); }, [options.length]);
  useLayoutEffect(() => {
    if (!isOpen) { setPosition(null); return; }
    function updatePosition(): void {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const width = Math.min(300, Math.max(0, window.innerWidth - margin * 2));
      const above = Math.max(0, rect.top - gap - margin);
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const naturalHeight = Math.min(340, popup.scrollHeight || 340);
      const placeAbove = above >= naturalHeight || above > below;
      const maxHeight = Math.min(340, Math.max(0, window.innerHeight - margin * 2), placeAbove ? above : below);
      const height = Math.min(naturalHeight, maxHeight);
      const next = {
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(placeAbove ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - height - margin)),
        width,
        maxHeight,
      };
      setPosition((previous) => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (popupRef.current) observer?.observe(popupRef.current);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [isOpen, options.length, onOpenSettings]);
  useLayoutEffect(() => { if (visible) listRef.current?.focus(); }, [visible]);
  useEffect(() => {
    if (isOpen && currentIndex >= 0) {
      document.getElementById(`${listId}-option-${currentIndex}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [currentIndex, isOpen, listId]);
  useEffect(() => {
    if (!isOpen) return;
    function dismissOutside(event: PointerEvent): void {
      if (!containsTarget(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [isOpen]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.target === triggerRef.current) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(selectedIndex >= 0 ? selectedIndex : event.key === "ArrowUp" ? orderedOptions.length - 1 : 0);
      }
      return;
    }
    if (event.target === settingsRef.current && event.key === "Tab") {
      if (event.shiftKey) {
        event.preventDefault();
        listRef.current?.focus();
      } else {
        // Continue from the composer trigger, rather than the portal at the end of the document.
        event.preventDefault();
        focusAfterTrigger();
      }
      return;
    }
    if (event.target !== listRef.current || !isOpen) return;
    if (event.key === "Tab") {
      if (event.shiftKey) {
        event.preventDefault();
        closeMenu(true);
      } else if (settingsRef.current) {
        event.preventDefault();
        settingsRef.current.focus();
      } else {
        event.preventDefault();
        focusAfterTrigger();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((currentIndex + step + orderedOptions.length) % orderedOptions.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : orderedOptions.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = orderedOptions[currentIndex];
      if (option) selectOption(option);
    }
  }

  return (
    <div
      ref={rootRef}
      className={["hive-model-picker", className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
      onBlur={(event) => { if (!containsTarget(event.relatedTarget)) closeMenu(); }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="hive-model-btn"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-label={label}
        title={selected ? `${selected.providerName} / ${selected.model}` : "Choose a model in Settings"}
        onClick={() => { if (isOpen) closeMenu(); else openMenu(); }}
      >
        <span className="hive-model-name">{selected?.model ?? placeholder}</span>
        <ChevronDownIcon size={14} />
      </button>
      {isOpen && createPortal(
        <div
          ref={popupRef}
          className="hive-model-menu"
          style={{ position: "fixed", bottom: "auto", left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 300, maxHeight: position?.maxHeight ?? 340, visibility: position ? "visible" : "hidden" }}
        >
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Configured models"
            aria-activedescendant={currentIndex >= 0 ? `${listId}-option-${currentIndex}` : undefined}
            tabIndex={-1}
          >
            {groups.map((group, groupIndex) => (
              <li key={group.providerId} role="group" aria-labelledby={`${listId}-group-${groupIndex}`}>
                <div id={`${listId}-group-${groupIndex}`} className="hive-model-group">{group.providerName}</div>
                <ul role="presentation">
                  {group.models.map((option) => {
                    const index = orderedOptions.indexOf(option);
                    return (
                      <li key={option.model} role="presentation">
                        <button
                          id={`${listId}-option-${index}`}
                          type="button"
                          role="option"
                          aria-selected={index === selectedIndex}
                          tabIndex={-1}
                          className={`hive-model-option${index === selectedIndex ? " is-selected" : ""}${index === currentIndex ? " is-active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => selectOption(option)}
                        >
                          {option.model}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {onOpenSettings && (
            <div className="hive-model-foot">
              <button ref={settingsRef} type="button" className="hive-model-option" onClick={() => { closeMenu(); onOpenSettings(); }}>
                Configure providers
              </button>
            </div>
          )}
        </div>, document.body
      )}
    </div>
  );
}
