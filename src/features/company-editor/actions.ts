"use server";

import { requireSession } from "@/server/auth/session";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { database } from "@/server/db";

export type SaveState = { error?: string; saved?: boolean };
const optionalText = z.string().trim().max(4000).transform(v => v || null);
const optionalUrl = z.string().trim().max(2000).refine(v => !v || /^https?:\/\//i.test(v) && URL.canParse(v), "Use a full http:// or https:// link.").transform(v => v || null);
const companySchema = z.object({
  company_id: z.uuid(), updated_at: z.string().min(1), name: z.string().trim().min(1, "Company name is required.").max(200),
  industry: optionalText, headquarters: optionalText, source: optionalUrl,
  domain: z.string().trim().max(253).refine(v => !v || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(v), "Enter a domain such as example.com, without https://.").transform(v => v.toLowerCase() || null),
  employee_count: z.string().trim().transform(v => v === "" ? null : Number(v)).pipe(z.number().int().min(0).max(2147483647).nullable()),
  workday_signal_date: z.string().refine(v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "Enter a valid date.").transform(v => v || null),
});
const insightsSchema = z.object({ company_id: z.uuid(), updated_at: z.string(), persona_override: optionalText, level_override: optionalText, why_now_override: optionalText });
const contactSchema = z.object({ company_id: z.uuid(), id: z.union([z.uuid(), z.literal("")]), name: z.string().trim().min(1, "Contact name is required.").max(200), title: optionalText, linkedin_url: optionalUrl, source: optionalUrl, mutual_connection: optionalText });

function refresh(id: string) { revalidatePath("/"); revalidatePath(`/companies/${id}`); }
function failure(error: unknown): SaveState {
  if (error instanceof z.ZodError) return { error: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" ") };
  return { error: error instanceof Error ? error.message : "Save failed. Please try again." };
}

export async function saveCompany(_: SaveState, form: FormData): Promise<SaveState> {
  try {
    await requireSession();
    const { company_id, updated_at, ...values } = companySchema.parse(Object.fromEntries(form));
    const { data, error } = await database().from("companies").update(values).eq("id", company_id).eq("updated_at", updated_at).select("id");
    if (error) throw new Error(error.code === "23505" ? "That company domain is already in use." : "Could not save company information.");
    if (!data?.length) throw new Error("This company changed since you opened it. Refresh the page before editing again.");
    refresh(company_id); return { saved: true };
  } catch (error) { return failure(error); }
}

export async function saveInsights(_: SaveState, form: FormData): Promise<SaveState> {
  try {
    await requireSession();
    const { company_id, updated_at, ...values } = insightsSchema.parse(Object.fromEntries(form));
    const db = database();
    if (updated_at) {
      const { data, error } = await db.from("company_insights").update(values).eq("company_id", company_id).eq("updated_at", updated_at).select("company_id");
      if (error) throw new Error("Could not save insights.");
      if (!data?.length) throw new Error("Insights changed since you opened this page. Refresh before editing again.");
    } else {
      const { error } = await db.from("company_insights").insert({ company_id, ...values });
      if (error) throw new Error(error.code === "23505" ? "Insights were added by someone else. Refresh before editing." : "Could not save insights.");
    }
    refresh(company_id); return { saved: true };
  } catch (error) { return failure(error); }
}

export async function saveContact(_: SaveState, form: FormData): Promise<SaveState> {
  try {
    await requireSession();
    const { id, company_id, ...values } = contactSchema.parse(Object.fromEntries(form));
    const db = database();
    if (id) {
      const { data, error } = await db.from("contacts").update(values).eq("id", id).eq("company_id", company_id).select("id");
      if (error || !data?.length) throw new Error("Could not save this contact. Refresh and try again.");
    } else {
      const { error } = await db.from("contacts").insert({ company_id, ...values });
      if (error) throw new Error("Could not add this contact.");
    }
    refresh(company_id); return { saved: true };
  } catch (error) { return failure(error); }
}
