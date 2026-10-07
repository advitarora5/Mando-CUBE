import { redirect } from "next/navigation";
import { hasSession } from "@/server/auth/session";
import { LoginForm } from "@/features/login/form";

export const dynamic = "force-dynamic";
export default async function LoginPage() {
  if (await hasSession()) redirect("/");
  return <main><header><a href="/login">mando <span>/ prospect intelligence</span></a></header>
    <section className="login-panel panel detail-section"><h1>Prospect Intelligence Shared Workspace</h1><p className="muted">Enter your team’s password to open the dashboard.</p><LoginForm /></section>
  </main>;
}
