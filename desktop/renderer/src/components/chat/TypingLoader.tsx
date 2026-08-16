import type { ChatRouteInfo } from "../../state";

export interface TypingLoaderProps {
  role: string;
  route?: ChatRouteInfo;
}

/** Pre-first-chunk indicator: ASCII ellipsis shimmer plus the resolved route line. */
export function TypingLoader({ role, route }: TypingLoaderProps) {
  const routeLine = route ? `${route.providerId}/${route.model}` : "resolving route";
  return (
    <div className="typing-loader" aria-label="HIVE is thinking">
      <span className="typing-dots anim-shimmer" aria-hidden="true">
        [...]
      </span>
      <span className="typing-route">
        {role} -&gt; {routeLine}
      </span>
    </div>
  );
}
