import { describe, expect, it, vi } from "vitest";
import { submitLocalSignIn } from "./signin-action";

function form(email?: string): FormData {
  const data = new FormData();
  if (email !== undefined) data.set("email", email);
  return data;
}

function dependencies(signIn = vi.fn(async () => "http://localhost:3000/api/auth/verify-request?provider=mailpit&type=email")) {
  return {
    signIn,
    rethrow: vi.fn(),
    redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
    logError: vi.fn(),
  };
}

describe("submitLocalSignIn", () => {
  it("normalizes the email before requesting a local sign-in link", async () => {
    const deps = dependencies();

    await expect(submitLocalSignIn(form("  Person@Example.COM  "), deps)).rejects.toThrow("redirect:/signin?check=email");

    expect(deps.signIn).toHaveBeenCalledWith("mailpit", { email: "person@example.com", redirectTo: "/chat", redirect: false });
  });

  it("rejects a missing email without calling Auth.js", async () => {
    const deps = dependencies();

    await expect(submitLocalSignIn(form(), deps)).rejects.toThrow("redirect:/signin?error=invalid_email");

    expect(deps.signIn).not.toHaveBeenCalled();
  });

  it("turns an adapter failure into a controlled error without logging its detail", async () => {
    const deps = dependencies(vi.fn(async (): Promise<string> => { throw new Error("ECONNREFUSED with private database address"); }));

    await expect(submitLocalSignIn(form("owner@example.com"), deps)).rejects.toThrow("redirect:/signin?error=signin_failed");

    expect(deps.logError).toHaveBeenCalledWith("Local sign-in failed", { error: "Error" });
    expect(JSON.stringify(deps.logError.mock.calls)).not.toContain("ECONNREFUSED");
  });

  it("turns an email-delivery failure into the same controlled error", async () => {
    const deps = dependencies(vi.fn(async () => "http://localhost:3000/api/auth/error?error=Configuration"));

    await expect(submitLocalSignIn(form("owner@example.com"), deps)).rejects.toThrow("redirect:/signin?error=signin_failed");

    expect(deps.logError).toHaveBeenCalledWith("Local sign-in failed", { error: "Error" });
    expect(JSON.stringify(deps.logError.mock.calls)).not.toContain("Configuration");
  });

  it("preserves Next.js navigation errors instead of replacing their redirect", async () => {
    const navigationError = new Error("NEXT_REDIRECT");
    const deps = dependencies(vi.fn(async (): Promise<string> => { throw navigationError; }));
    deps.rethrow.mockImplementation((error) => { throw error; });

    await expect(submitLocalSignIn(form("owner@example.com"), deps)).rejects.toBe(navigationError);

    expect(deps.logError).not.toHaveBeenCalled();
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});
