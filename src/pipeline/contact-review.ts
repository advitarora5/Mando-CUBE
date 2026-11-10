import { z } from "zod";
import { normalizeDomain } from "../domain/ingestion/normalize.ts";
import { daysSince } from "../domain/scoring/go-live.ts";

export function linkedinProfile(value: string | null | undefined): string | null {
  const match = typeof value === "string" && value.trim().match(/^https:\/\/(?:www\.)?linkedin\.com\/in\/([\w%-]+)\/?(?:[?#].*)?$/i);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : null;
}

const httpsUrl = z.url({ protocol: /^https$/ });
const evidence = {
  company_domain: z.string().transform(normalizeDomain).pipe(z.string()),
  linkedin_url: z.string().transform(linkedinProfile).pipe(z.string()),
  reviewed_on: z.iso.date(),
  source: httpsUrl,
};

export const contactReviewsSchema = z.array(z.discriminatedUnion("status", [
  z.strictObject({ ...evidence, status: z.literal("confirmed"), title: z.string().trim().min(1).max(200), workday_source: httpsUrl.optional() }),
  z.strictObject({ ...evidence, status: z.literal("different_employer") }),
])).superRefine((reviews, ctx) => {
  const seen = new Set<string>();
  for (const review of reviews) {
    const key = `${review.company_domain}:${review.linkedin_url}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate company and profile in contact reviews" });
    seen.add(key);
  }
});

export type ContactReview = z.infer<typeof contactReviewsSchema>[number];

// A reviewed role ages independently of the discovery signal. A future review cannot confer credit.
export function currentContactReviews(reviews: ContactReview[], domain: string, now: Date) {
  const companyDomain = normalizeDomain(domain);
  return new Map(reviews.filter(review => {
    const days = daysSince(review.reviewed_on, now);
    return review.company_domain === companyDomain && days !== null && days >= 0 && days <= 90;
  }).map(review => [review.linkedin_url, review]));
}
