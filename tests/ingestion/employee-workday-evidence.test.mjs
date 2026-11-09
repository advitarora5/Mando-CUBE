import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, clock } from './helpers.mjs';
import { lookupEmployeeWorkday } from '../../src/pipeline/employee-workday-evidence.ts';
const company = {id:'c1',name:'Pilot Corp'};
function context(text='We employ more than 9000 employees worldwide.') {
 const ctx=makeCtx({now:clock('2026-11-08T12:00:00Z')});ctx.employeeWebResearch=true;
 ctx.store.workdaySites=async()=>[{company_id:'c1',normalized_name:'pilot',tenant:'pilot',pod:'wd5',site:'Careers',enabled:true}];
 ctx.store.websiteEvidenceCaptures=async()=>[{url:'https://pilot.wd5.myworkdayjobs.com/wday/cxs/pilot/Careers/job/Engineer',last_seen_at:'2026-11-01T12:00:00Z',meta:{kind:'workday_job',company_id:'c1'},body:JSON.stringify({jobPostingInfo:{jobDescription:`<p>${text}</p>`}})}];return ctx;
}
test('reuses bound Workday employer description without fetching and preserves observation date',async()=>{
 const ctx=context();ctx.fetch=()=>{throw Error('must not fetch')};
 const evidence=await lookupEmployeeWorkday(ctx,company);
 assert.equal(evidence.employee_count,9000);assert.equal(evidence.basis,'lower_bound');assert.equal(evidence.as_of,'2026-11-01');assert.equal(evidence.date_basis,'observed');
});
test('Workday evidence requires current exact-company tenant and capture binding',async()=>{
 for(const change of ['disabled','stale','other-company','other-host','unbound-capture']){
 const ctx=context();const rows=await ctx.store.websiteEvidenceCaptures();
 if(change==='disabled')ctx.employeeWebResearch=false;
 if(change==='stale')rows[0].last_seen_at='2025-01-01T00:00:00Z';
 if(change==='other-company')company.id='other';
 if(change==='other-host')rows[0].url='https://other.wd5.myworkdayjobs.com/wday/cxs/pilot/Careers/job/Engineer';
 if(change==='unbound-capture')rows[0].meta.company_id=null;
 ctx.store.websiteEvidenceCaptures=async()=>rows;
 assert.equal(await lookupEmployeeWorkday(ctx,company),null,change);company.id='c1';
 }
});
test('Workday descriptions reject customers, planned workforces and parent-group scope',async()=>{
 for(const text of ['Our customers have 9000 employees.','We will have 9000 employees.','Pilot Group has 9000 employees.','We have approximately 3000 employees.'])assert.equal(await lookupEmployeeWorkday(context(text),company),null,text);
});
test('employer workforce synonyms work and approximation wording stays approximate',async()=>{
 assert.equal((await lookupEmployeeWorkday(context('We employ over 9000 associates worldwide.'),company)).employee_count,9000);
 assert.equal((await lookupEmployeeWorkday(context('We employ 9000 staff worldwide.'),company)).employee_count,9000);
 for(const qualifier of ['roughly','some'])assert.equal(await lookupEmployeeWorkday(context(`We have ${qualifier} 3000 employees.`),company),null);
});
test('normal scoring awards the size bonus from reused Workday evidence',async()=>{
 const {scoreStage}=await import('../../src/pipeline/stages.ts');
 const ctx=context();const id=ctx.store.addExistingCompany({name:'Pilot Corp',domain:'pilot.example'});ctx.store.companyRows[0].pipeline=true;
 const captures=await ctx.store.websiteEvidenceCaptures();captures[0].meta.company_id=id;ctx.store.websiteEvidenceCaptures=async()=>captures;
 const sites=await ctx.store.workdaySites();sites[0].company_id=id;ctx.store.workdaySites=async()=>sites;
 await ctx.store.insertContact({company_id:id,name:'Pat',title:'Director of HRIS',source:'https://pilot.example/team',linkedin_status:'confirmed',linkedin_url:null,email:null,email_status:null,phone:null,phone_status:null,mutual_connection:null});
 const result=await scoreStage(ctx);
 assert.equal(result.counts.employee_evidence_workday,1);
 assert.equal((await ctx.store.latestScore(id)).authority_score,23);
 assert.match((await ctx.store.latestScore(id)).authority_evidence,/observed on 2026-11-01/);
});
