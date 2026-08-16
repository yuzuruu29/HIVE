import { redirect } from "next/navigation";
import { currentSubject } from "./subject";

export async function requireSubject() {
  const subject = await currentSubject();
  if (!subject) redirect("/signin");
  return subject;
}
