// Reviewed website branding only. This does not rename issuers, merge companies,
// or replace the required Workday evidence. Never infer aliases from name prefixes.
export const websiteIdentityAliases = [
  {
    company: "cerence",
    domain: "cerence.com",
    names: ["Cerence AI"],
    sources: [
      "https://www.cerence.com/about/about-us",
      "https://www.cerence.com/about/careers",
    ],
  },
] as const;
