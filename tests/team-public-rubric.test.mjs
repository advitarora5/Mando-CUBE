import assert from 'node:assert/strict';
import {test} from 'node:test';
import {contactAuthority,contactReachability,budgetScore,timingScore,releaseScore} from '../scripts/team-public-rubric.mjs';
const src='https://example.org/proof';
const c={name:'Test',current:true,role_base:18,role_source:src,role_reason:'CIO',workday_owner:false,channels:[{type:'linkedin',supported:true,source:src,reason:'Matching profile'}]};
const w={threshold_verified:true,source:src,reason:'4000 employees'};
test('Authority bonuses require same current person',()=>{assert.equal(contactAuthority(c,w).score,21);assert.equal(contactAuthority({...c,current:null,workday_owner:true},w).score,5)});
test('Unsourced verified flag does not earn verification; independent second channel',()=>{assert.equal(contactReachability(c,'2026-10-12').score,10);assert.equal(contactReachability({...c,channels:[...c.channels,{type:'email',supported:true,source:src,reason:'Published named email',verified:true}]},'2026-10-12').score,18)});
test('Personal initiative/action same event cannot stack',()=>{const e={start:'2026-05-01',end:'2026-05-01',source:src,reason:'Named initiative',activity_id:'same',active:true};assert.equal(contactReachability({...c,initiatives:[e],active_actions:[e]},'2026-10-12').score,13)});
test('Budget requires positive operating result and takes highest tool',()=>{const f={positive_operating:false,revenue_growth:true,operating_growth:true,source:src,reason:'Operating loss'};const t={kind:'historical',internal:true,source:src,reason:'Actual adoption'};assert.equal(budgetScore(f,[t,t],'2026-10-12').score,3);assert.equal(budgetScore({...f,positive_operating:true},[t],'2026-10-12').score,15)});
const company={workday:{current:true,source:src},release:{next_confirmed_date:null},timing_events:[]};
test('Timing baseline and strongest bounded event, selection zero',()=>{assert.equal(timingScore(company,'2026-10-12').score,5);assert.equal(timingScore({...company,workday:{current:false}},'2026-10-12').score,0);const e={kind:'completed_go_live',start:'2026-06-01',end:'2026-06-01',source:src,reason:'Actual completed deployment'};assert.equal(timingScore({...company,timing_events:[e,{...e,kind:'rollout'}]},'2026-10-12').score,12)});
test('Release score defaults to 0; confirmed dates earn points only in readiness window',()=>{// A confirmed current Workday customer without a confirmed upcoming release dates earns 0
	assert.equal(releaseScore(company,'2026-10-12').score,0,'no release date → 0 (was default 8)');
// Below the 42-day readiness window (40 days out)
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2026-11-21'}},'2026-10-12').score,0,'40 days out (<42) → 0');
// Lower boundary exactly 42 days out, with documented prep → 15
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2026-11-23',documented_preparation:true}},'2026-10-12').score,15,'42 days with prep → 15');
// Lower boundary exactly 42 days out, without documented prep → 12
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2026-11-23'}},'2026-10-12').score,12,'42 days no prep → 12');
// Upper boundary exactly 84 days out, with documented prep → 15
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2027-01-04',documented_preparation:true}},'2026-10-12').score,15,'84 days with prep → 15');
// Upper boundary exactly 84 days out, without documented prep → 12
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2027-01-04'}},'2026-10-12').score,12,'84 days no prep → 12');
// 84-126 day window, 126 days out → 10
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2027-02-15'}},'2026-10-12').score,10,'126 days interior → 10');
// Above the 126-day window, 127 days out → 0
	assert.equal(releaseScore({...company,release:{next_confirmed_date:'2027-02-16'}},'2026-10-12').score,0,'127 days out (>126) → 0');
// Not a current Workday customer → 0
	assert.equal(releaseScore({...company,workday:{current:false,source:src}},'2026-10-12').score,0,'not current → 0');});
