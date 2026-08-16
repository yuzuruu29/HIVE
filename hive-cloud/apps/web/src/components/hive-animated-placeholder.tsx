"use client";

import { useEffect, useState } from "react";

const PLACEHOLDERS = [
  "Ask HIVE to compare AI models",
  "Ask HIVE to review a codebase",
  "Ask HIVE to plan a feature",
  "Ask HIVE to research with citations",
  "Ask HIVE to launch a Build Council",
  "Ask HIVE to analyze an uploaded file",
];

export function useHiveAnimatedPlaceholder({ enabled, fallback }: { enabled: boolean; fallback: string }) {
  const [placeholder, setPlaceholder] = useState(fallback);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!enabled || reducedMotion.matches) {
      setPlaceholder(fallback);
      return;
    }

    let timer: number | undefined;
    let phraseIndex = 0;
    let characterIndex = 0;
    let deleting = false;

    const schedule = (delay: number) => {
      timer = window.setTimeout(step, delay);
    };

    const step = () => {
      const phrase = PLACEHOLDERS[phraseIndex] ?? fallback;
      characterIndex += deleting ? -1 : 1;
      setPlaceholder(phrase.slice(0, Math.max(0, characterIndex)));

      if (!deleting && characterIndex >= phrase.length) {
        deleting = true;
        schedule(1_350);
        return;
      }

      if (deleting && characterIndex <= 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % PLACEHOLDERS.length;
        schedule(320);
        return;
      }

      schedule(deleting ? 28 : 48);
    };

    setPlaceholder("");
    schedule(260);
    return () => window.clearTimeout(timer);
  }, [enabled, fallback]);

  return placeholder;
}
