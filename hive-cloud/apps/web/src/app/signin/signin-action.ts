type LocalSignInDependencies = {
  signIn: (provider: "mailpit", options: { email: string; redirectTo: string; redirect: false }) => Promise<string>;
  rethrow: (error: unknown) => void;
  redirect: (path: string) => never;
  logError: (message: string, details: { error: string }) => void;
};

export async function submitLocalSignIn(
  formData: FormData,
  { signIn, rethrow, redirect, logError }: LocalSignInDependencies,
): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) redirect("/signin?error=invalid_email");

  try {
    const destination = await signIn("mailpit", { email, redirectTo: "/chat", redirect: false });
    const destinationUrl = new URL(destination, "http://localhost");
    const isVerifyRequest = destinationUrl.pathname === "/api/auth/verify-request"
      || (destinationUrl.pathname === "/signin" && destinationUrl.searchParams.get("check") === "email");
    if (!isVerifyRequest) {
      throw new Error("AuthSignInFailed");
    }
  } catch (error) {
    rethrow(error);
    logError("Local sign-in failed", { error: error instanceof Error ? error.name : "UnknownError" });
    redirect("/signin?error=signin_failed");
  }

  redirect("/signin?check=email");
}
