"use client";

import { useActionState } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, {});
  return <form action={action}>
    <div className="field-grid"><label className="full-width">Password<input name="password" type="password" autoComplete="current-password" required maxLength={1024} autoFocus /></label></div>
    {state.error && <p className="error" role="alert">{state.error}</p>}
    <button className="button" disabled={pending}>{pending ? "Signing in…" : "Open dashboard"}</button>
  </form>;
}
