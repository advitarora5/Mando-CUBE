import { describeMovement, type Movement } from "@/domain/history";

// Rank change as plain text in a semantic colour: green up, red down, gray unchanged or new.
export function Delta({ movement, current, emptyLabel = "", note }: { movement: Movement | null; current?: number; emptyLabel?: string; note?: string }) {
  if (!movement) return emptyLabel ? <span className="delta delta-flat">{emptyLabel}</span> : null;
  const label = note ? `${describeMovement(movement, current)}. ${note}` : describeMovement(movement, current);
  const text = movement.kind === "up" ? `▲${movement.places}` : movement.kind === "down" ? `▼${movement.places}` : movement.kind === "new" ? "New" : "–";
  const tone = movement.kind === "up" ? "delta-up" : movement.kind === "down" ? "delta-down" : "delta-flat";
  return <span className={`delta ${tone}`} title={label} aria-label={label}>{text}</span>;
}
