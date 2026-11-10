# Credible headcount estimates — proposed, not adopted

The shared `mando-public-evidence-v4` rubric says: “For a confirmed current relevant
contact, add **3** if their employer/group is confirmed to have 3,000+ employees”.
It also says: “Match workforce scope to the contact's employer; employee count
alone earns no Authority points.” It does not specify exact-only headcounts or a
blanket estimate ban. PR #50's approximate-count exclusion is a conservative
implementation choice, not that quoted rubric requirement.

Proposal for team/client approval:

- Permit a credible estimate to establish the size condition when its methodology,
  source, date and employer/group scope support the threshold. Preserve its estimate
  label; never store it as an exact count or a guaranteed lower bound.
- Prefer dated employer disclosures. Hold contradictory sources, ambiguous entity
  mappings, future timestamps, unknown counting methods and ranges crossing 3,000.
  A provider's index date is not automatically the workforce effective date.
- A range entirely above 3,000 may support the condition if it estimates the relevant
  workforce; profile/email coverage alone cannot establish it. A point estimate
  close to the cutoff needs corroboration or documented uncertainty sufficient to
  support the classification. Do not invent confidence bounds or a new threshold.
- Keep the confirmed current relevant contact requirement, best-contact calculation,
  +3 value, 25-point cap and duplicate-award protections. Approval of an evidence
  policy does not authorize shared score writes.

Team/client decisions: acceptable providers/methodologies; what constitutes
sufficient uncertainty/corroboration near 3,000; freshness windows; group scope
appropriate to the contact; and who reviews exceptions. Current 548/30-day windows
and the approximate-count exclusion remain unchanged pending that decision.

Hunter-only bonuses remain held. Its numeric `employeesCount` field lacks a clear
field-level methodology/effective-date definition in the reviewed public API
reference. Prologis's Hunter 3,839 conflicts with its disclosed 2,802 at December 31,
2025; differing dates do not justify silently choosing Hunter. Advantech instead
has independent official evidence: 9,512 at March 31, 2026. See the separate
[Advantech extraction case](ADVANTECH_EXTRACTION_20261110.md).
