// Opt in with COMPANY_TRANSFER_TEST_CONTAINER=supabase_db_Mando-CUBE.
// All fictional writes are rolled back, including the simulated COMMIT/retry path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { planTransfer, transferSql } from '../../scripts/company-transfer.mjs';
import { transferFixture } from '../helpers/company-transfer-fixture.mjs';
const container = process.env.COMPANY_TRANSFER_TEST_CONTAINER;
function psql(sql, mustPass = true) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (mustPass) assert.equal(result.status, 0, result.stderr);
  return result;
}
const snapshotSql = "select coalesce(json_agg(json_build_object('id',id,'name',name,'domain',domain)), '[]') from public.companies;";
const countsSql = `select json_build_array((select count(*) from public.companies), (select count(*) from public.raw_captures),
 (select count(*) from public.signals),(select count(*) from public.workday_sites),(select count(*) from public.extractions),
 (select count(*) from public.pipeline_runs),(select count(*) from public.scores));`;
const inside = sql => sql.replace('BEGIN;', '').replace(/COMMIT;\s*$/, 'DROP TABLE transfer_map; DROP TABLE transfer_payload;');

test('local SQL transfers evidence, retries without duplicates, preserves target facts, and rolls back', { skip: !container }, () => {
  const snapshot = JSON.parse(psql(snapshotSql).stdout), before = psql(countsSql).stdout;
  const data = transferFixture(), attach = transferFixture();
  const target = { id: randomUUID(), name: 'Existing Orchid Bastion', domain: attach.companies[0].company.domain };
  for (const key of ['companies', 'captures', 'extractions']) data[key].push(...attach[key]);
  const plan = planTransfer(data, [...snapshot, target]);
  assert.deepEqual(plan.mapping.map(m => m.action), ['create', 'attach']);
  const body = inside(transferSql(plan, { apply: true }));
  const companyId = data.companies[0].company.id;
  const sql = `BEGIN;
    CREATE TEMP TABLE fixture_before AS SELECT (select count(*) from public.scores) scores;
    INSERT INTO public.companies(id,name,domain,employee_count) VALUES('${target.id}','${target.name}','${target.domain}',123);
    ${body}
    ${body}
    DO $$ BEGIN
      IF (select count(*) from public.signals where company_id in ('${companyId}','${target.id}'))<>2 THEN RAISE EXCEPTION 'Signals duplicated'; END IF;
      IF (select count(*) from public.workday_sites where company_id in ('${companyId}','${target.id}'))<>2 THEN RAISE EXCEPTION 'Sites duplicated'; END IF;
      IF (select count(*) from public.raw_captures where url in ('${data.captures[0].url}','${data.captures[1].url}'))<>2 THEN RAISE EXCEPTION 'Captures duplicated'; END IF;
      IF (select count(*) from public.extractions e join public.raw_captures c on c.id=e.capture_id where c.url in ('${data.captures[0].url}','${data.captures[1].url}'))<>2 THEN RAISE EXCEPTION 'Extractions duplicated'; END IF;
      IF (select employee_count from public.companies where id='${target.id}')<>123 THEN RAISE EXCEPTION 'Target overwritten'; END IF;
      IF (select count(*) from public.company_origins where company_id='${companyId}')<>1 THEN RAISE EXCEPTION 'Missing pipeline origin'; END IF;
      IF EXISTS(select 1 from public.signals where company_id in ('${companyId}','${target.id}') AND (first_seen_at<>'2026-10-01T12:00:00Z'::timestamptz OR last_seen_at<>'2026-10-01T12:00:00Z'::timestamptz)) THEN RAISE EXCEPTION 'Evidence freshness changed'; END IF;
      IF EXISTS(select 1 from public.signals s join public.extractions e on e.id=s.extraction_id where s.company_id in ('${companyId}','${target.id}') AND e.capture_id<>s.capture_id) THEN RAISE EXCEPTION 'Broken extraction mapping'; END IF;
      IF (select count(*) from public.scores)<>(select scores from fixture_before) THEN RAISE EXCEPTION 'Scores changed'; END IF;
    END $$;
    ROLLBACK;`;
  psql(sql);
  assert.equal(psql(countsSql).stdout, before);
  // The real default preview also rolls back.
  psql(transferSql(planTransfer(transferFixture(), snapshot)));
  assert.equal(psql(countsSql).stdout, before);
});

test('local ownership conflicts and stale plans abort atomically', { skip: !container }, () => {
  const snapshot = JSON.parse(psql(snapshotSql).stdout), before = psql(countsSql).stdout;
  const data = transferFixture(), other = { id: randomUUID(), name: 'Existing Orchid Bastion', domain: `${randomUUID()}.example` };
  const site = data.companies[0].sites[0];
  const result = psql(`BEGIN;
    INSERT INTO public.companies(id,name,domain) VALUES('${other.id}','${other.name}','${other.domain}');
    INSERT INTO public.workday_sites(tenant,pod,site,company_name,normalized_name,match_kind,company_id)
    VALUES('${site.tenant}','${site.pod}','${site.site}','Other employer','other employer','manual','${other.id}');
    ${inside(transferSql(planTransfer(data, [...snapshot, other]), { apply: true }))}
    ROLLBACK;`, false);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Workday site belongs to another company/);
  assert.equal(psql(countsSql).stdout, before);
  const stale = psql(transferSql(planTransfer(transferFixture(), [])), false);
  assert.notEqual(stale.status, 0); assert.match(stale.stderr, /Target companies changed/);
  assert.equal(psql(countsSql).stdout, before);
});

test('explicit pending review resolves once; changed scope and past rejection remain protected', { skip: !container }, () => {
  const snapshot = JSON.parse(psql(snapshotSql).stdout), before = psql(countsSql).stdout;
  const data = transferFixture(), e = data.companies[0], r = data.captures[0], signal = e.signals[0], site = e.sites[0], review = randomUUID();
  const plan = planTransfer(data, snapshot, { pendingReviews: [{ id: review, local_company_id: e.company.id,
    note: 'Explicit fictional review', signal_ids: [signal.id], site_ids: [site.id] }] });
  const seed = `BEGIN;
    INSERT INTO public.review_queue(id,candidate_name,normalized_name,reason) VALUES('${review}','${e.company.name}','${e.company.name.toLowerCase()}','no_website');
    INSERT INTO public.raw_captures(id,source_id,url,fetched_at,http_status,content_hash,body) VALUES('${r.id}','${r.source_id}','${r.url}','${r.fetched_at}',200,'${r.content_hash}','${r.body}');
    INSERT INTO public.signals(id,review_item_id,capture_id,type,source_url,quote,confidence,first_seen_at,last_seen_at)
      VALUES('${signal.id}','${review}','${r.id}','${signal.type}','${signal.source_url}','${signal.quote}',0.9,'${signal.first_seen_at}','${signal.last_seen_at}');
    INSERT INTO public.workday_sites(id,review_item_id,capture_id,tenant,pod,site,company_name,normalized_name,match_kind)
      VALUES('${site.id}','${review}','${r.id}','${site.tenant}','${site.pod}','${site.site}','${e.company.name}','${site.normalized_name}','manual');`;
  const body = inside(transferSql(plan, { apply: true }));
  psql(`${seed}${body}${body}
    DO $$ BEGIN
      IF NOT EXISTS(select 1 from public.review_queue where id='${review}' AND status='approved' AND resolved_company_id='${e.company.id}') THEN RAISE EXCEPTION 'Review unresolved'; END IF;
      IF NOT EXISTS(select 1 from public.signals where id='${signal.id}' AND company_id='${e.company.id}') THEN RAISE EXCEPTION 'Pending signal unassigned'; END IF;
      IF NOT EXISTS(select 1 from public.workday_sites where id='${site.id}' AND company_id='${e.company.id}') THEN RAISE EXCEPTION 'Pending site unassigned'; END IF;
    END $$; ROLLBACK;`);
  const changed = psql(`${seed}
    INSERT INTO public.signals(review_item_id,capture_id,type,source_url,quote,confidence) VALUES('${review}','${r.id}','hiring','${r.url}','Unexpected queued claim',0.5);
    ${body}ROLLBACK;`, false);
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Explicit pending review evidence changed/);
  const rejected = psql(`${seed}UPDATE public.review_queue SET status='rejected',decided_at=now() WHERE id='${review}';${body}ROLLBACK;`, false);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Explicit pending review changed or was rejected/);
  assert.equal(psql(countsSql).stdout, before);
});
