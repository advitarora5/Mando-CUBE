import test from 'node:test';
import assert from 'node:assert/strict';
import {runCandidateBatch,batchDeadline} from '../scripts/discovery-batch.mjs';
const attempt = (checked=1, admitted=1) => ({status:'succeeded', jobs:[{job:'match',status:'succeeded',counts:{candidates:checked,new_companies:admitted}},{job:'score',status:'succeeded',counts:{scored:admitted}}]});
test('overnight cutoff can only shorten batches and rejects expired or malformed windows',()=>{
  const now=Date.parse('2026-11-04T13:40:00Z');
  assert.equal(batchDeadline('2026-11-04T13:45:00Z',now),300000);
  assert.equal(batchDeadline('2026-11-05T13:45:00Z',now),3000000);
  for(const end of ['garbage','2026-11-04T13:40:00Z','2026-11-04T12:00:00Z'])assert.throws(()=>batchDeadline(end,now));
});
test('five-candidate batch runs sequentially and never exceeds five admissions',async()=>{
  let active=0,calls=0;
  const r=await runCandidateBatch({maxCandidates:5,deadlineMs:3000000,run:async()=>{assert.equal(active++,0);calls++;await Promise.resolve();active--;return attempt();}});
  assert.equal(calls,5);assert.equal(r.admitted,5);assert.equal(r.status,'completed');
});
test('empty queue stops batch without repeating collection',async()=>{
  let calls=0;const r=await runCandidateBatch({maxCandidates:5,deadlineMs:3000000,run:async()=>{calls++;return attempt(0,0);}});
  assert.equal(calls,1);assert.equal(r.status,'no_eligible_candidates');
});
test('failed processing stops while archive-only failure permits later admission attempts',async()=>{
  for(const processingFailure of [true,false]){
    let calls=0;const r=await runCandidateBatch({maxCandidates:2,deadlineMs:3000000,run:async()=>{calls++;const a=attempt();if(calls===1){a.status='needs_attention';a.jobs.unshift({job:'collect',status:'failed'});if(processingFailure)a.jobs[1].status='failed';}return a;}});
    assert.equal(calls,processingFailure?1:2);assert.equal(r.status,'needs_attention');
  }
});
test('deadline prevents further workers and bounds each worker',async()=>{
  let time=0,calls=0;const r=await runCandidateBatch({maxCandidates:5,deadlineMs:1000,now:()=>time,run:async(i,remaining)=>{assert.equal(remaining,1000);calls++;time=1000;return attempt();}});
  assert.equal(calls,1);assert.equal(r.status,'time_limit');
});

test('missing checkpoints stop safely and a failed score retains recorded admissions',async()=>{
  const failed=await runCandidateBatch({maxCandidates:5,deadlineMs:1000,run:async()=>({status:'failed'})});
  assert.equal(failed.attempts.length,1);assert.equal(failed.status,'needs_attention');
  const partial=await runCandidateBatch({maxCandidates:5,deadlineMs:1000,run:async()=>{const a=attempt();a.jobs[1].status='failed';return a;}});
  assert.equal(partial.admitted,1);assert.equal(partial.attempts.length,1);
});
