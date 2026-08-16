"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight } from "@phosphor-icons/react";

export function WaitlistForm() {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("Invites are reviewed manually. No payment details required.");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setState("loading");
    const form = new FormData(formElement);
    const response = await fetch("/api/cloud/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), use_case: form.get("use_case"), website: form.get("website") }),
    }).catch(() => null);
    if (!response?.ok) {
      setState("error");
      setMessage("The waitlist request could not be saved. Please try again.");
      return;
    }
    setState("success");
    setMessage("You are on the list. We will email you when an invite is ready.");
    formElement.reset();
  }

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="waitlist-email">Work email</label>
        <input className="input" id="waitlist-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
      </div>
      <div className="field">
        <label htmlFor="waitlist-use-case">What do you want HIVE to route?</label>
        <textarea className="textarea" id="waitlist-use-case" name="use_case" maxLength={1000} placeholder="Chat, code review, model evaluation, or another workflow" />
      </div>
      <div className="field" aria-hidden="true" style={{ position: "absolute", left: "-10000px" }}>
        <label htmlFor="waitlist-website">Website</label>
        <input id="waitlist-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button className="button button-primary" type="submit" disabled={state === "loading"}>
        {state === "loading" ? "Joining..." : "Join the beta"}
        <ArrowRight size={16} weight="bold" aria-hidden="true" />
      </button>
      <p className="form-message" data-state={state}>{message}</p>
    </form>
  );
}
