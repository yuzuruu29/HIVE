"use client";

import { useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { hiveTheme } from "@/theme/hive-theme";
import { ShareDialog } from "@/components/share-dialog";

/**
 * E2E test page for the ShareDialog component.
 *
 * Renders a trigger button and a controlled ShareDialog so Playwright
 * can drive the full open/close, focus-trap, create, copy, and revoke
 * interaction surface in a real browser environment.
 */
export default function ShareDialogE2EPage() {
  const [open, setOpen] = useState(false);

  return (
    <Theme theme={hiveTheme}>
      <LinkProvider
        component={({
          href,
          children,
          ...rest
        }: {
          href: string;
          children?: React.ReactNode;
        }) => (
          <a href={href} {...rest}>
            {children}
          </a>
        )}
      >
        <button id="open-share-dialog" data-testid="open-share-trigger" onClick={() => setOpen(true)}>
          Open share dialog
        </button>

        <span id="focus-trap-sentinel-before" tabIndex={0}>
          Before
        </span>

        <ShareDialog
          conversationId="test-conversation-1"
          conversationTitle="Test Conversation"
          open={open}
          onClose={() => setOpen(false)}
        />

        <span id="focus-trap-sentinel-after" tabIndex={0}>
          After
        </span>

        <div id="e2e-test-output" data-testid="dialog-state">
          {open ? "open" : "closed"}
        </div>
      </LinkProvider>
    </Theme>
  );
}
