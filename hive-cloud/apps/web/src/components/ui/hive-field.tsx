"use client";

import { Field as AstryxField } from "@astryxdesign/core/Field";
import type { ComponentProps } from "react";

export function HiveField(props: ComponentProps<typeof AstryxField>) {
  return <AstryxField {...props} />;
}

export function HiveFieldGroup({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {description && <small>{description}</small>}
    </div>
  );
}
