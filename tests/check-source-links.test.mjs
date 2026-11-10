import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkLink, employerMatches, linksOf, linksToTenant, tenantMatchesName, tenantVariants, workdaySite } from "../scripts/check-source-links.mjs";

test("checkLink separates open, 404 and unreachable; linksOf keeps only http(s) links", async () => {
  const server = createServer((req, res) => { res.statusCode = req.url === "/gone" ? 404 : 200; res.end("We run Workday HCM"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await checkLink(`${base}/ok`), { opens: true, status: 200, workday: "not-workday", mentionsWorkday: true });
    assert.equal((await checkLink(`${base}/gone`)).opens, false);
  } finally { server.close(); }
  assert.equal((await checkLink(`${base}/ok`)).opens, false); // server closed
  assert.deepEqual(linksOf({ source: "SEC list", signals: [{ source_url: "https://a.com/x" }, { source_url: "https://a.com/x" }] }), ["https://a.com/x"]);
});

test("workdaySite only recognises Workday careers hosts and skips a locale segment", () => {
  assert.deepEqual(workdaySite("https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/x"), { origin: "https://pfizer.wd1.myworkdayjobs.com", tenant: "pfizer", site: "PfizerCareers" });
  assert.equal(workdaySite("https://pfizer.wd1.myworkdayjobs.com/en-US/PfizerCareers").site, "PfizerCareers");
  assert.equal(workdaySite("https://evil.com/pfizer.wd1.myworkdayjobs.com/x"), null);
  assert.equal(workdaySite("https://news.com/workday-go-live"), null);
});

test("tenantMatchesName accepts name, initials and legal-suffix variants but flags unrelated tenants", () => {
  for (const [tenant, name] of [["cisco", "Cisco Systems"], ["bristolmyerssquibb", "Bristol-Myers Squibb Co."], ["pg", "Procter & Gamble"], ["wf", "Wells Fargo & Company"], ["cvshealth", "CVS Health"]])
    assert.equal(tenantMatchesName(tenant, name), true, `${tenant} / ${name}`);
  assert.equal(tenantMatchesName("pfizer", "Cisco Systems"), false);
  assert.equal(tenantMatchesName("jpmc", "JPMorgan Chase & Co."), false); // real tenant, not resembling the name: flagged for a manual look
});

test("tenantVariants, employerMatches and linksToTenant", () => {
  assert.deepEqual(tenantVariants("Procter & Gamble Co", "pg.com"), ["proctergamble", "procter", "pg"]);
  assert.ok(tenantVariants("CVS Health Corporation", "www.cvshealth.com").includes("cvshealth"));
  assert.equal(employerMatches("S73 Pfizer Investment Co., Ltd. China", "Pfizer Inc."), true);
  assert.equal(employerMatches("Cisco", "Cisco Systems"), true);
  assert.equal(employerMatches("Pfizer Inc", "Cisco Systems"), false);
  assert.equal(employerMatches(null, "Cisco Systems"), false);
  assert.equal(linksToTenant('<a href="https://amgen.wd1.myworkdayjobs.com/en-US/Careers/login">', "amgen"), true);
  assert.equal(linksToTenant('<a href="https://other.wd1.myworkdayjobs.com/x">', "amgen"), false);
});
