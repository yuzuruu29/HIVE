import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChangesView } from "./ChangesView";

const multiFilePatch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old line
+new line
 context line
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,3 @@
+line one
+line two
 context`;

describe("ChangesView component", () => {
  it("renders two-pane layout with file navigation rail and added/removed counts", () => {
    render(<ChangesView patch={multiFilePatch} truncated={false} />);

    expect(screen.getByRole("navigation", { name: /modified files/i })).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();

    // src/a.ts has +1 -1
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    // src/b.ts has +2
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("toggles line wrapping class when wrap lines button is clicked", async () => {
    render(<ChangesView patch={multiFilePatch} truncated={false} />);
    const user = userEvent.setup();

    const wrapBtn = screen.getByRole("button", { name: /toggle line wrapping/i });
    expect(wrapBtn).toHaveTextContent("Wrap lines: OFF");

    await user.click(wrapBtn);
    expect(wrapBtn).toHaveTextContent("Wrap lines: ON");
  });

  it("collapses and expands file lines on button click", async () => {
    render(<ChangesView patch={multiFilePatch} truncated={false} />);
    const user = userEvent.setup();

    expect(screen.getByText("-old line")).toBeInTheDocument();

    const toggleA = screen.getByRole("button", { name: /toggle src\/a\.ts/i });
    await user.click(toggleA);

    // -old line should now be hidden/collapsed
    expect(screen.queryByText("-old line")).not.toBeInTheDocument();

    // click again to expand
    await user.click(toggleA);
    expect(screen.getByText("-old line")).toBeInTheDocument();
  });
});
