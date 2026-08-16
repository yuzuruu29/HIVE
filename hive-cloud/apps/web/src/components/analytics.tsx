"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export function Analytics() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || navigator.doNotTrack === "1") return;
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: "localStorage+cookie",
      person_profiles: "identified_only",
      property_denylist: ["prompt", "message", "content", "api_key", "authorization"],
    });
    posthog.capture("cloud_app_loaded", { surface: location.pathname.startsWith("/chat") ? "chat" : location.pathname.startsWith("/build") ? "build" : "marketing" });
    return () => posthog.reset();
  }, []);
  return null;
}
