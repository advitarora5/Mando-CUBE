// Hand-checked company name -> SEC CIK, for names the exact-name match misses (the SEC spells them differently, or several
// filers share the name). Key = normalizeName(name). Each CIK was confirmed against the SEC record named in the comment.
// Never add an entry from a guess: a wrong entry puts another company's filing on a score. Names that match exactly need no entry.
export const SEC_ALIASES: Record<string, number> = {
  otis: 1781335, // Otis Worldwide Corp
  target: 27419, // TARGET CORP ("target" is shared by several filers, so the exact index drops it)
  "sun life": 1097362, // SUN LIFE FINANCIAL INC
  "msd merck and": 310158, // Merck & Co., Inc. (listed as "MSD (Merck & Co.)")
  jll: 1037976, // JONES LANG LASALLE INC
  google: 1652044, // Alphabet Inc.
  meta: 1326801, // Meta Platforms, Inc.
  ubs: 1610520, // UBS Group AG (the parent; UBS AG is a subsidiary filer)
  "wells fargo": 72971, // WELLS FARGO & COMPANY/MN
  delta: 27904, // DELTA AIR LINES, INC.
};

// EU/UK companies for the filings.xbrl.org source whose legal name differs from the company name, or whose LEI has no Wikidata item to confirm it.
// Key = the foreign source's normalized name. Each LEI was checked against its GLEIF record (legal name, country, status ISSUED) on 2026-11-09.
// An entry whose newest annual filing is older than 18 months returns stale_filing and scores nothing until a newer filing is published.
export const FOREIGN_LEI_ALIASES: Record<string, { lei: string; name: string }> = {
  amadeus: { lei: "9598004A3FTY3TEHHN09", name: "Amadeus IT Group SA" },
  scandic: { lei: "529900JY9ZBGUXGRKQ86", name: "Scandic Hotels Group AB" },
  abrdn: { lei: "0TMBS544NMO7GLCE7H90", name: "Aberdeen Group plc (formerly abrdn plc)" },
  posti: { lei: "743700DOHLQIENKTC391", name: "Posti Group Oyj" },
  "maisons du monde": { lei: "9695009DV2698O4ZBU71", name: "Maisons du Monde" },
  norconsult: { lei: "635400VFBLRSFRXLGQ03", name: "Norconsult ASA" },
  "air liquide": { lei: "969500MMPQVHK671GT54", name: "L'Air Liquide SA" },
  leonardo: { lei: "529900X4EEX1U9LN3U39", name: "Leonardo SpA" },
  azelis: { lei: "699400M9RRMTV264FM70", name: "Azelis Group" },
};

// Banks the FDIC source may be asked about. Key = normalizeName(name). A bank name is not unique (a "Bank of the West" lookup matched a
// small unrelated charter), so only a name checked by hand against its FDIC record is looked up at all.
export const BANK_ALLOWLIST = new Set<string>([
  "first national bank of omaha", // FDIC record checked: net income 491.2M (FY2025), the Omaha bank
]);
