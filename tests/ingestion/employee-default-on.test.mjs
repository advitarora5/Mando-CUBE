import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeCtx,clock,fakeFetch,response} from './helpers.mjs';
import {contextFromEnv} from '../../src/pipeline/context.ts';
import {employeeResearchEnabled,employeeDeadline,ensureEmployeeResearchReady} from '../../src/pipeline/employee-research-setup.ts';
import {savedEmployeeEvidence} from '../../src/pipeline/employee-evidence.ts';
import {scoreStage} from '../../src/pipeline/stages.ts';
import {runPipeline,statusOf} from '../../src/pipeline/runner.ts';
const NOW='2026-11-10T18:00:00Z';
async function world() {
 const warnings=[];
 const ctx=makeCtx({now:clock(NOW),fetch:fakeFetch([
  {match:/\/robots.txt$/,respond:()=>response(404,'')},
  {match:/pilot.example\/$/,respond:()=>response(200,'<title>Pilot Corp</title><p>We employ 3500 employees worldwide.</p>',{'content-type':'text/html'})},
 ])});
 delete ctx.employeeWebResearch;
 ctx.contact='';ctx.log={info(){},warn(m){warnings.push(m)},error(){}};
 const id=ctx.store.addExistingCompany({name:'Pilot Corp',domain:'pilot.example'});ctx.store.companyRows[0].pipeline=true;
 const person=await ctx.store.insertContact({company_id:id,name:'Pat',title:'Director of HRIS',source:'https://pilot.example/team',linkedin_status:'confirmed'});
 ctx.store.workdaySites=async()=>[];
 return {ctx,id,person,warnings};
}
function next(ctx) {const result={...ctx};delete result.employeeResearchReadiness;return result;}
function makeDue(ctx,id) {ctx.store.employeeResearchRows.get(id).next_check_at='2020-01-01T00:00:00Z';}

test('normal contexts use enabled missing/empty settings; explicit disable variants avoid setup access',async()=>{
 for(const flag of [undefined,'','  ','1','true','yes','on','0','false','OFF','no',' disable ']) {
  const {ctx}=await world();let checks=0;
  ctx.store.checkEmployeeResearchStorage=async()=>{checks++};
  const env={TREG_BUDGET_USD:'0',...(flag===undefined?{}:{PIPELINE_EMPLOYEE_WEB_RESEARCH:flag})};
  const made=await contextFromEnv(env,{dryRun:true,store:ctx.store,noLlm:true,noTreg:true});
  assert.equal(made.employeeWebResearch,employeeResearchEnabled(flag));
  assert.equal(checks,made.employeeWebResearch?1:0);
  await ensureEmployeeResearchReady(made);assert.equal(checks,made.employeeWebResearch?1:0);
 }
});

test('default-on collects official evidence; off suppresses Workday, storage and public requests',async()=>{
 const {ctx,id}=await world();const run=await scoreStage(ctx);
 assert.equal(run.counts.employee_web_ran,1);assert.equal(run.counts.employee_web_activity_ran,1);
 assert.equal((await ctx.store.latestScore(id)).authority_score,23);
 const other=await world();other.ctx.employeeWebResearch=false;
 other.ctx.store.checkEmployeeResearchStorage=other.ctx.store.workdaySites=async()=>{throw Error('must not read')};
 const disabled=await scoreStage(other.ctx);
 assert.equal(disabled.counts.employee_research_disabled,1);assert.equal(disabled.counts.employee_web_disabled,1);
 assert.equal(other.ctx.fetch.calls.length,0);assert.equal((await other.ctx.store.latestScore(other.id)).authority_score,20);
});

test('saved Workday descriptions stay default-on even when website cache setup is missing',async()=>{
 const {ctx,id,warnings}=await world();
 ctx.store.checkEmployeeResearchStorage=async()=>{throw Error('missing table, private details')};
 ctx.store.workdaySites=async()=>[{company_id:id,normalized_name:'pilot',tenant:'pilot',pod:'wd5',site:'Careers'}];
 ctx.store.websiteEvidenceCaptures=async()=>[{url:'https://pilot.wd5.myworkdayjobs.com/wday/cxs/pilot/Careers/job/1',last_seen_at:NOW,meta:{kind:'workday_job',company_id:id},body:JSON.stringify({jobPostingInfo:{jobDescription:'Pilot Corp. We employ 3500 employees worldwide.'}})}];
 const run=await scoreStage(ctx);
 assert.equal(run.counts.employee_evidence_workday,1);assert.equal(run.counts.employee_workday_ran,1);
 assert.equal(run.counts.employee_web_skipped_evidence,1);assert.equal((await ctx.store.latestScore(id)).authority_score,23);
 assert.equal(ctx.fetch.calls.length,0);assert.equal(warnings.length,1);assert.doesNotMatch(warnings[0],/private details/);
});

test('missing setup or permissions skips websites, preserves valid saved evidence, and keeps unrelated stages running',async()=>{
 for(const failure of ['missing table','permission denied']) {
  const {ctx,id,warnings}=await world();await scoreStage(ctx);
  ctx.store.employeeResearchRows.clear();ctx.store.checkEmployeeResearchStorage=async()=>{throw Error(failure)};
  const later=next(ctx);later.fetch=()=>{throw Error('no source call without readiness')};
  let enriched=false;const status=ctx.store.enrichmentStatus.bind(ctx.store);ctx.store.enrichmentStatus=async(...args)=>{enriched=true;return status(...args)};
  const report=await runPipeline(later,{plan:'daily',limit:1,dryRun:false,trigger:'manual'});
  const score=report.jobs.find(j=>j.job==='score');
  assert.ok(score);assert.equal(score.status,'succeeded');assert.equal(score.counts.employee_web_activity_skipped_setup,1);
  assert.equal(score.counts.employee_evidence_retained,1);assert.equal((await ctx.store.latestScore(id)).authority_score,23);
  assert.ok(report.jobs.some(j=>j.job==='enrich'));assert.equal(report.treg_spend_usd,0);
  assert.ok(warnings.some(w=>/cache storage or permissions/.test(w)));
  assert.equal(enriched,true);
 }
});

test('source timeouts preserve fresh cached/assessment headcount, but expiry and contact eligibility still apply',async()=>{
 const {ctx,id,person,warnings}=await world();await scoreStage(ctx);
 makeDue(ctx,id);ctx.now.advanceDays(1);
 const failed=next(ctx);failed.fetch=async()=>{throw new DOMException('source timed out','TimeoutError')};
 const run=await scoreStage(failed);
 assert.equal(run.counts.employee_web_activity_failed,1);assert.equal(run.counts.employee_web_ran,1);
 assert.equal((await ctx.store.latestScore(id)).authority_score,23);
 assert.equal(ctx.store.employeeResearchRows.get(id).evidence.employee_count,3500);
 assert.ok(warnings.some(w=>/failed or timed out/.test(w)));
 await ctx.store.updateContact(person,{contact_sources:{role_review:{status:'different_employer'}}});
 await scoreStage(next(failed));assert.equal((await ctx.store.latestScore(id)).authority_score,0);
 await ctx.store.updateContact(person,{contact_sources:null});ctx.now.advanceDays(31);makeDue(ctx,id);
 await scoreStage(next(failed));assert.equal((await ctx.store.latestScore(id)).authority_score,20);
});

test('failed cache persistence cannot create a new bonus or discard a validated below-threshold disclosure',async()=>{
 const {ctx,id}=await world();ctx.store.finishEmployeeResearch=async()=>{throw Error('permission denied')};
 const run=await scoreStage(ctx);assert.equal(run.counts.employee_web_activity_failed,1);
 assert.equal((await ctx.store.latestScore(id)).authority_score,20);
 const original=await world();await scoreStage(original.ctx);makeDue(original.ctx,original.id);
 const later=next(original.ctx);later.fetch=fakeFetch([
  {match:/robots.txt$/,respond:()=>response(404,'')},
  {match:/pilot.example\/$/,respond:()=>response(200,'<title>Pilot Corp</title><p>We employ 2000 employees worldwide.</p>',{'content-type':'text/html'})},
 ]);later.store.finishEmployeeResearch=async()=>{throw Error('unavailable')};
 await scoreStage(later);assert.equal((await later.store.latestScore(original.id)).authority_score,20);
});

test('retention only accepts previously awarded dated exact/lower-bound evidence within the same freshness rules',()=>{
 const valid='https://pilot.example/team | Pat: role 20 + size 3 + Workday owner 0. Headcount at least 3500 observed on 2026-11-09: https://reports.example/report.pdf';
 assert.equal(savedEmployeeEvidence(valid,new Date(NOW)).employee_count,3500);
 for(const v of [valid.replace('size 3','size 0'),valid.replace('at least ','approximately '),valid.replace('2026-11-09','2026-09-01'),valid.replace('2026-11-09','2027-01-01'),valid.replace('3500','2999'),valid.replace('https://reports.example/report.pdf','javascript:alert(1)'),'size3']) assert.equal(savedEmployeeEvidence(v,new Date(NOW)),null,v);
 assert.equal(savedEmployeeEvidence(valid.replace('observed on 2026-11-09','as of 2025-12-31'),new Date(NOW)).date_basis,'effective');
 assert.equal(savedEmployeeEvidence(valid.replace('observed on 2026-11-09','as of 2020-12-31'),new Date(NOW)),null);
});

test('optional deadline rejects a non-cooperative adapter without blocking unrelated work',async()=>{
 await assert.rejects(employeeDeadline(()=>new Promise(()=>{}),5),/timed out/);
 const {ctx,id}=await world();ctx.store.checkEmployeeResearchStorage=async()=>{throw new DOMException('readiness timeout','TimeoutError')};
 const run=await scoreStage(ctx);assert.equal(statusOf(run),'succeeded');assert.equal((await ctx.store.latestScore(id)).authority_score,20);
});

test('default-on headcount never requests paid enrichment or a paid search fallback',async()=>{
 const {ctx}=await world();const calls=[];
 ctx.treg={call:async(endpoint,options)=>{calls.push({endpoint,options});return {ok:true,status:200,cost_usd:0,body:{results:[]}}}};
 const result=await scoreStage(ctx);
 assert.equal(result.treg_spend_usd,0);assert.equal(calls.length,1);
 assert.equal(calls[0].endpoint,'tinyfish.web.search');
 assert.equal(calls[0].options.headers['X-Treg-Route-Max-Cost'],'0');
 assert.equal(calls[0].options.headers['X-Treg-Route-Waterfall'],'0');
});

test('startup readiness is bounded when an adapter never resolves',async()=>{
 const {ctx,id}=await world();ctx.store.checkEmployeeResearchStorage=()=>new Promise(()=>{});
 const started=Date.now();const result=await scoreStage(ctx);
 assert.ok(Date.now()-started<8000);
 assert.equal(result.counts.employee_web_activity_skipped_setup,1);
 assert.equal(statusOf(result),'succeeded');assert.equal((await ctx.store.latestScore(id)).authority_score,20);
});

test('cached and opted-out runs report no new research; a Workday timeout does not stop scoring',async()=>{
 const {ctx,id,warnings}=await world();await scoreStage(ctx);
 const cached=await scoreStage(ctx);assert.equal(cached.counts.employee_web_activity_cached,1);assert.equal(cached.counts.employee_web_ran,undefined);
 const disabled={...next(ctx),employeeWebResearch:false};disabled.fetch=()=>{throw Error('must not fetch')};
 const off=await scoreStage(disabled);assert.equal(off.counts.employee_web_disabled,1);assert.equal(off.counts.employee_evidence_retained,1);
 assert.equal((await ctx.store.latestScore(id)).authority_score,23);
 const failed=next(ctx);failed.store.workdaySites=async()=>{throw new DOMException('Workday source timeout','TimeoutError')};
 const outcome=await scoreStage(failed);assert.equal(outcome.counts.employee_workday_failed,1);assert.equal(statusOf(outcome),'succeeded');
 assert.ok(warnings.some(w=>/Workday headcount lookup failed or timed out/.test(w)));
});
