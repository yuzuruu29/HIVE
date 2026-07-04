export * from "./colors.js";
export * from "./terminal.js";
export * from "./banner.js";
export * from "./branding.js";
export * from "./frame.js";
export * from "./status-rail.js";

// Re-export other existing ui modules if any
export { renderDashboard, renderStatus } from "./dashboard.js";
export { runProviderSetupWizard } from "./setup.js";
// Note: src/ui/tui.tsx (Ink/React) is preserved but not exported here.
// The persistent TUI cockpit is in src/tui/ and accessed via src/cli.ts.
