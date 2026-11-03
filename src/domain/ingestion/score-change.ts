// What the pipeline records on a new score row so the dashboard can say why a score changed, instead of guessing.
// Pure and dependency-free: scripts and the pipeline run it directly under Node.
const CATS = ["authority", "reachability", "budget", "release", "timing"] as const;
const LABEL: Record<(typeof CATS)[number], string> = { authority: "Authority", reachability: "Reachability", budget: "Budget", release: "Release", timing: "Timing" };

export const scoreTriggers = ["pipeline_run", "new_contacts", "csv_import", "periodic_refresh"] as const;
export type ScoreTrigger = (typeof scoreTriggers)[number];

// What started the scoring run, in plain words (used by the dashboard hover).
export const triggerLabel: Record<ScoreTrigger, string> = {
  pipeline_run: "the pipeline scored new or changed signals",
  new_contacts: "new contacts were found",
  csv_import: "the company was imported",
  periodic_refresh: "a periodic refresh with no score change",
};

export type ScoreChange = { run_id: string | null; change_trigger: ScoreTrigger; previous_score_id: string | null; change_summary: string };
type ScoreLike = Record<string, unknown>;

// The one-line reason after "url | Assessment status: met." in a stored evidence string.
function reasonOf(evidence: unknown): string {
  const text = typeof evidence === "string" ? evidence : "";
  const afterLink = text.includes(" | ") ? text.slice(text.indexOf(" | ") + 3) : text;
  return afterLink.replace(/^Assessment status: \w+\.\s*/, "").replace(/^Evidence:\s*/, "").replace(/\s+/g, " ").trim();
}
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// One sentence per changed category with the new reason, e.g. "Authority 20 to 25: Jane Doe, VP HRIS: role confirmed 20 + size 3."
export function describeScoreChange(previous: ScoreLike | null, row: ScoreLike, trigger: ScoreTrigger): string {
  if (!previous) return "First assessment.";
  const changed = CATS.filter(c => Number(previous[`${c}_score`]) !== Number(row[`${c}_score`]));
  if (!changed.length) {
    return trigger === "periodic_refresh" ? "Re-saved with no score change (periodic refresh)." : "Evidence or tier updated; no category score changed.";
  }
  const parts = changed.map(c => {
    const reason = reasonOf(row[`${c}_evidence`]);
    return `${LABEL[c]} ${Number(previous[`${c}_score`])} to ${Number(row[`${c}_score`])}${reason ? `: ${clip(reason, 110)}` : ""}`;
  });
  return clip(parts.join(" "), 480);
}

export function buildScoreChange(args: { previous: (ScoreLike & { id?: string }) | null; row: ScoreLike; trigger: ScoreTrigger; runId: string | null }): ScoreChange {
  return {
    run_id: args.runId,
    change_trigger: args.trigger,
    previous_score_id: typeof args.previous?.id === "string" ? args.previous.id : null,
    change_summary: describeScoreChange(args.previous, args.row, args.trigger),
  };
}
