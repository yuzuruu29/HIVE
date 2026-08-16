"use client";

import { hiveTheme as builtHiveTheme } from "./hive";
import { X, CaretDown, Check, MagnifyingGlass, Warning, WarningCircle, CheckCircle, Spinner } from "@phosphor-icons/react";

const hiveIcons = {
  close: <X size="1em" aria-hidden />,
  chevronDown: <CaretDown size="1em" aria-hidden />,
  check: <Check size="1em" aria-hidden />,
  search: <MagnifyingGlass size="1em" aria-hidden />,
  warning: <Warning size="1em" aria-hidden />,
  warningCircle: <WarningCircle size="1em" aria-hidden />,
  checkCircle: <CheckCircle size="1em" aria-hidden />,
  spinner: <Spinner size="1em" aria-hidden />,
};

export const hiveTheme = {
  ...builtHiveTheme,
  icons: hiveIcons,
};
