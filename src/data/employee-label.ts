export function employeeLabel(
  count: number | null,
  authorityEvidence: string | null | undefined,
): string | null {
  if (count !== null && Number.isFinite(count)) {
    return count.toLocaleString("en-US");
  }

  const marker =
    "Unmapped spreadsheet research; category evidence needs review.\n";
  const evidence = authorityEvidence ?? "";
  const start = evidence.indexOf(marker);

  if (start < 0) return null;

  try {
    const research: unknown = JSON.parse(
      evidence.slice(start + marker.length)
    );

    if (!research || typeof research !== "object" || Array.isArray(research)) {
      return null;
    }

    const value =
      (research as Record<string, unknown>).estimated_employees;

    if (typeof value !== "string") return null;
    const match = value.trim().match(/^~?\s*\d[\d,]*(?:\s*\+)?/);
    return match ? match[0].replace(/\s/g, "") : null;
  } catch {
    return null;
  }
}