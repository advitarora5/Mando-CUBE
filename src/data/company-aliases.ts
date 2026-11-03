// Reviewed alternative names for companies on the dashboard: legal names, former names and abbreviations
// that the name rules in src/domain/ingestion/normalize.ts would not match on their own.
// The pipeline, the Import button and scripts/import-companies.mjs check these before adding a company.
// Add the old name here after merging a duplicate (npm run companies:merge prints the line to add).
// Seeded from the research aliases in src/data/research/workday-companies.json.

export type CompanyAlias = { company_id: string; name: string; aliases: string[] };
// Pairs a person checked and confirmed are different companies, so the duplicate report stops listing them.
export type DistinctCompanies = { company_ids: [string, string]; note: string };

export const companyAliases: CompanyAlias[] = [
  { company_id: "c0fcbcd1-c86a-5d47-9144-001b6ec1f518", name: "A1 Group", aliases: ["A1 (Telekom Austria)"] },
  { company_id: "5ebefc64-8e92-5291-9ee9-df3ff6c1a9f8", name: "AIA Group", aliases: ["AIA Shared Services (Hong Kong) Limited"] },
  { company_id: "59173e6a-ad62-53b0-99b4-d92654e5d954", name: "CL Grupo Industrial", aliases: ["Cristian Lay S.L. (CL Grupo Industrial)"] },
  { company_id: "af7b3c8c-513e-5962-a005-42ee2caf48b1", name: "Ferring Pharmaceuticals", aliases: ["Ferring International Center S.A."] },
  { company_id: "e53f08f9-86da-54fe-b068-f730bd77e256", name: "Flex", aliases: ["Flextronics"] },
  { company_id: "81e53346-4db1-5a34-9dd8-77ee0746e7b1", name: "IU Group", aliases: ["Career Partner"] },
  { company_id: "0d7ea78d-6376-5f97-b5d8-e16e3783aee9", name: "Jardine Matheson", aliases: ["Jardines (Jardine, Matheson & Co., Limited)"] },
  { company_id: "bc2ae135-27a4-556c-aadd-a7ee06699451", name: "JLL", aliases: ["JLL Singapore"] },
  { company_id: "95ef7076-99ae-555d-915c-3f8c168651c3", name: "KGI Financial", aliases: ["Kai Fund Holdings (formerly China Development Financial Holdings)"] },
  { company_id: "a42a4a1a-63a0-57dd-b7b4-7a3477c93234", name: "MGM China", aliases: ["MGM Grand Paradise Limited"] },
  { company_id: "00e6f2f2-171e-5cd9-9776-93e13ac0a3fb", name: "Mondelēz International", aliases: ["Mondelez Global LLC"] },
  { company_id: "59c4c900-2919-50ab-ba25-1dc7fd8af6eb", name: "PwC", aliases: ["PricewaterhouseCoopers Global Licensing Services Corporation (pwc)"] },
  { company_id: "0c9a3679-c609-5441-bac6-3e2ecf163a62", name: "RMIT University", aliases: ["Royal Melbourne Institute of Technology"] },
  { company_id: "5ec9bee4-793b-5831-8613-a7fb8ffe4045", name: "SGS", aliases: ["SGS Société Générale de Surveillance SA"] },
  { company_id: "fdae1414-9777-5775-9ed1-dc67d2aa5498", name: "Veolia UK & Ireland", aliases: ["Veolia (ES) UK Limited (FIN)"] },
];

export const distinctCompanies: DistinctCompanies[] = [];
