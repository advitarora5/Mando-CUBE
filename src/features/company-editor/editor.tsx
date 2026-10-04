"use client";

import { useActionState, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { SaveState } from "./actions";

export type Field = { name: string; label: string; value: string | number | null; type?: "text" | "url" | "number" | "date" | "textarea"; required?: boolean; help?: string };

export function Editor({ action, hidden, fields, children, label = "Edit", title }: {
  action: (state: SaveState, form: FormData) => Promise<SaveState>;
  hidden: Record<string, string>; fields: Field[]; children: ReactNode; label?: string; title: string;
}) {
  const [editing, setEditing] = useState(false);
  const router = useRouter();
  const [state, submit, pending] = useActionState(async (previous: SaveState, form: FormData) => {
    const result = await action(previous, form);
    if (result.saved) { setEditing(false); router.refresh(); }
    return result;
  }, {});
  return <div className="editor">
    {!editing ? <><div className="section-title"><h2>{title}</h2><button className="button secondary" onClick={() => setEditing(true)}>{label}</button></div>{children}{state.saved && <p role="status" className="success">Saved successfully.</p>}</> :
      <form action={submit}><h2>{title}</h2>
        {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <div className="field-grid">{fields.map(field => <label key={field.name}>{field.label}{field.type === "textarea" ? <textarea name={field.name} defaultValue={field.value ?? ""} rows={3} maxLength={4000} /> : <input name={field.name} type={field.type ?? "text"} defaultValue={field.value ?? ""} required={field.required} min={field.type === "number" ? 0 : undefined} step={field.type === "number" ? 1 : undefined} />}{field.help && <small>{field.help}</small>}</label>)}</div>
        {state.error && <p role="alert" className="error">{state.error}</p>}
        <div className="form-buttons"><button className="button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button><button className="button secondary" type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button></div>
      </form>}
  </div>;
}
