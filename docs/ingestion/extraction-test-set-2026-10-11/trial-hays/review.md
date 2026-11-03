# First Hays extraction trial

Ran local llama3.1:8b with temperature 0 and JSON output. The model received only the Hays source capture and extraction instructions, not the expected answers. No application implementation or database changes were made.

## Correct results

- Identified Hays Electrical Services and explicit Workday HCM usage.
- Left publication date, project dates, employee count and named contacts unknown.
- Returned valid JSON and an exact source quotation with a valid capture/segment reference.

## Problems

- Set the vacancy signal to Active and verified true. The saved posting cannot verify current live status; this flag is unsupported.
- Reduced the signal to hiring, missing the explicit active implementation, parallel payroll/benefits testing, cutover readiness and release-testing responsibilities.
- Listed Workday System as an explicitly named product; this is generic system wording, not a distinct module.
- Returned uncertainties null despite an undated source and unverified present status.
- Used its own nested field structure and field labels. The prompt listed fields without enforcing a strict schema, so this should be addressed in the test design.

The one provided quotation is valid, but it does not support current verification and does not independently support every asserted field. Valid JSON alone is not a successful extraction.

## Next trial

Agree on explicit output fields and status meanings, distinguish described source activity from independently verified current status, require individual evidence for each claim, and request separate hiring, implementation and testing signals. Rerun Hays, then try Miami University to test partial event dates and students versus employees. Do not generalize model quality from this one case.
