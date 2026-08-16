"use server";

type LocalSignOutDependencies = {
  signOut: (options: { redirectTo: string }) => Promise<void>;
};

export async function executeSignOut(
  deps: LocalSignOutDependencies,
): Promise<void> {
  await deps.signOut({ redirectTo: "/" });
}

export async function signOutAction(): Promise<void> {
  const { signOut } = await import("@/auth");
  await executeSignOut({ signOut });
}
