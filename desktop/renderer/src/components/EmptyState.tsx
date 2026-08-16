import { ReactNode } from "react";

export function EmptyState({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`empty-state ${className}`}>{children}</div>;
}
