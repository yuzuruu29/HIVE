"use client";

import { motion, useReducedMotion } from "motion/react";

const routes = [
  { provider: "OpenRouter", model: "free pool", width: "88%", status: "selected", active: true },
  { provider: "Groq", model: "Llama 3.3", width: "64%", status: "standby", active: false },
  { provider: "NVIDIA", model: "NIM catalog", width: "48%", status: "standby", active: false },
];

export function RouteVisual() {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="route-console"
      initial={reduce ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
      aria-label="Live example of HIVE 0.1 evaluating model routes"
    >
      <div className="route-console-head">
        <strong>HIVE 0.1</strong>
        <span className="status-chip">route selected</span>
      </div>
      <div className="route-lines">
        {routes.map((route, index) => (
          <div className="route-line" data-active={route.active} key={route.provider}>
            <strong>{route.provider}</strong>
            <div className="route-track" aria-hidden="true">
              <motion.span
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.8, delay: 0.5 + index * 0.13, ease: [0.16, 1, 0.3, 1] }}
                style={{ width: route.width }}
              />
            </div>
            <span>{route.status}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
