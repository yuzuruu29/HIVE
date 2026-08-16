import { describe, expect, it, vi } from "vitest";
import { executeSignOut } from "./signout-action";

describe("executeSignOut", () => {
  it("calls signOut with redirectTo set to root", async () => {
    const signOut = vi.fn(async () => {});

    await executeSignOut({ signOut });

    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/" });
  });

  it("calls signOut exactly once", async () => {
    const signOut = vi.fn(async () => {});

    await executeSignOut({ signOut });

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
