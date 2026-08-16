"use client";

import { useState } from "react";

interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  cta: string;
  href: string;
}

const STEPS: OnboardingStep[] = [
  {
    id: "connect",
    label: "Choose your path",
    description: "Get 50 starter credits or connect your own provider keys (BYOK).",
    cta: "Set up provider",
    href: "/settings/providers",
  },
  {
    id: "first-run",
    label: "Run your first build",
    description: 'Try "Build a launch page" or "Review this idea" to see Queen-led orchestration.',
    cta: "Start a build",
    href: "/?mode=build",
  },
  {
    id: "inspect",
    label: "Inspect the receipt",
    description: "See exactly which model, provider, and cost your result used.",
    cta: "View route receipt",
    href: "#receipt",
  },
];

export function OnboardingChecklist({ completed }: { completed: string[] }) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || completed.length >= STEPS.length) return null;

  const nextStep = STEPS.find((s) => !completed.includes(s.id));

  return (
    <div className="onboarding-checklist" role="complementary" aria-label="Getting started">
      <h3>Getting Started</h3>
      <ol>
        {STEPS.map((step, i) => {
          const isCompleted = completed.includes(step.id);
          const isCurrent = !isCompleted && STEPS.findIndex(s => !completed.includes(s.id)) === i;
          return (
            <li key={step.id} className={isCompleted ? "completed" : isCurrent ? "current" : "pending"}>
              {isCompleted ? "✓" : `${i + 1}`}. {step.label}
            </li>
          );
        })}
      </ol>
      {nextStep && (
        <div className="onboarding-cta">
          <p>{nextStep.description}</p>
          <a href={nextStep.href}>{nextStep.cta} →</a>
        </div>
      )}
      <button className="dismiss" onClick={() => setDismissed(true)} type="button">Skip for now</button>
    </div>
  );
}
