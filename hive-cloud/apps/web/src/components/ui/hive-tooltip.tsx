"use client";

import { Tooltip } from "@astryxdesign/core/Tooltip";

export const HiveTooltip = Tooltip;

export function HiveTooltipWrapper({
  content,
  children,
}: {
  content: string;
  children: React.ReactNode;
}) {
  return <Tooltip content={content}>{children}</Tooltip>;
}
