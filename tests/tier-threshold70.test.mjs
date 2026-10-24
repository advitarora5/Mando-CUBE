import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {evaluateTier,applyTierRules} from '../src/domain/scoring/tier-rules.ts';
import {buildAssessment} from '../src/domain/scoring/assessment.ts';
import {tierThresholds,RUBRIC_VERSION} from '../src/domain/scoring/rubric.ts';
import {displayTier} from '../src/domain/scoring/display.ts';
import {views,applyState,defaultState} from '../src/features/pipeline/state.ts';
const evidence='https://example.com | Assessment status: met. Synthetic reviewed evidence.';
const score=total=>({authority_score:25,reachability_score:25,budget_score:total===100?20:total-50,release_score:total===100?15:0,timing_score:total===100?15:0,...Object.fromEntries(['authority','reachability','budget','release','timing'].map(k=>[k+'_evidence',evidence]))});
test('54/55/69/70/100 boundaries agree across shared evaluator, dashboard and automated assessment builder',()=>{
 assert.deepEqual(tierThresholds,{Qualified:70,Maybe:55});assert.equal(RUBRIC_VERSION,'week2-100-v2-qualified70');
 for(const [total,tier]of [[54,'Disqualified'],[55,'Maybe'],[69,'Maybe'],[70,'Qualified'],[100,'Qualified']]){const row=score(total);const display=applyTierRules({...row,total:-1,tier:'Disqualified'});assert.equal(display.total,total);assert.equal(display.tier,tier);assert.equal(displayTier(display),tier);const built=buildAssessment('test',Object.fromEntries(['authority','reachability','budget','release','timing'].map(k=>[k,{score:row[k+'_score'],source:'https://example.com',reason:'Assessment status: met. Synthetic reviewed evidence.'}])));assert(built.ok);assert.equal(built.total,total);assert.equal(built.tier,tier);assert.equal(built.row.rubric_version,RUBRIC_VERSION);}
});
test('missing, unknown and partial required evidence remain gated even at100',()=>{
 for(const field of ['authority_evidence','reachability_evidence'])for(const ev of ['', 'https://example.com | Assessment status: unknown. Unresolved.', 'https://example.com | Assessment status: partial. Unresolved.']){const r=applyTierRules({...score(100),[field]:ev});assert.equal(r.tier,'Disqualified');assert.equal(displayTier(r),'Not Enough Evidence');}
});
test('negative, above-cap, NaN and infinite category values retain invalid-score handling',()=>{
 for(const [key,value]of [['authority_score',26],['budget_score',-1],['reachability_score',NaN],['timing_score',Infinity]]){const r=evaluateTier({...score(100),[key]:value});assert.equal(r.tier,'Disqualified');assert.match(r.tier_reason,/rubric limits/);}
 const r=evaluateTier({...score(100),authority_score:0,reachability_score:0,budget_score:0});assert.match(r.tier_reason,/Timing signals alone/);
});
test('pipeline hints derive from authoritative configuration and labels/filters retain their behavior',()=>{
 assert.equal(views.find(v=>v.id==='qualified').hint,'Total 70+ with complete evidence');assert.equal(views.find(v=>v.id==='maybe').hint,'Total 55–69');
 const rows=[69,70].map(n=>({id:String(n),name:String(n),contacts:[],score:applyTierRules({...score(n),total:n,tier:'Maybe'})}));assert.deepEqual(applyState(rows,{...defaultState,view:'qualified'}).map(r=>r.id),['70']);assert.deepEqual(applyState(rows,{...defaultState,view:'maybe'}).map(r=>r.id),['69']);
 for(const f of ['src/server/repositories/companies.ts','src/server/repositories/company-detail.ts','src/server/repositories/todays-leads.ts','scripts/save-weekly-snapshot.mjs'])assert.match(fs.readFileSync(new URL('../'+f,import.meta.url),'utf8'),/applyTierRules/);
 assert.match(fs.readFileSync(new URL('../scripts/team-public-rubric.mjs',import.meta.url),'utf8'),/buildAssessment/);
});

test('reviewed HTTPS/SQL imports reject stale tiers through the same evidence-gated evaluator',async()=>{
 const {assertReviewedTiers}=await import('../scripts/validate-reviewed-tiers.mjs');
 const row={...score(70),tier:'Qualified'};assert(assertReviewedTiers([{row,total:70,display_tier:'Qualified'}]));
 assert.throws(()=>assertReviewedTiers([{row:{...row,tier:'Maybe'},total:70,display_tier:'Maybe'}]),/shared evaluator/);
 assert.throws(()=>assertReviewedTiers([{row:{...row,authority_evidence:''},total:70,display_tier:'Qualified'}]),/shared evaluator/);
 for(const f of ['scripts/save-reviewed-evidence.mjs','scripts/team43-scoring-sql.py','scripts/companies105-127-scoring-sql.py'])assert.match(fs.readFileSync(new URL('../'+f,import.meta.url),'utf8'),/validate-reviewed-tiers/);
});

test('PM team scoring pipeline evaluates a synthetic70-point result with the shared rubric version',async()=>{
 const {assessTeamCompany,TEAM_RUBRIC_VERSION}=await import('../scripts/team-public-rubric.mjs');const source='https://example.com/proof';
 const company={company_id:'synthetic',workforce:{threshold_verified:true,source,reason:'Synthetic matched4000 workforce'},contacts:[{name:'Synthetic HRIS VP',current:true,role_base:22,role_source:source,role_reason:'Synthetic explicit HRIS executive',workday_owner:false,channels:[{type:'linkedin',supported:true,source,reason:'Synthetic matching profile'}],initiatives:[],active_actions:[]}],financial:{positive_operating:true,revenue_growth:true,operating_growth:false,source,reason:'Synthetic positive annual operations, revenue growth, declining operating result'},technology:[{kind:'modernization',active:true,internal:true,source,reason:'Synthetic active HR modernization'}],workday:{current:true,source},release:{next_confirmed_date:null,policy_source:source},timing_events:[{kind:'rollout',start:'2026-03-01',end:'2026-03-01',source,reason:'Synthetic dated rollout'}]};
 const result=assessTeamCompany(company,'2026-10-12');assert.equal(result.total,62);assert.equal(result.tier,'Maybe');assert.equal(result.display_tier,'Maybe');assert.equal(result.row.rubric_version,`${RUBRIC_VERSION}:${TEAM_RUBRIC_VERSION}`);assert.equal(evaluateTier(result.row).tier,applyTierRules(result.row).tier);
});
