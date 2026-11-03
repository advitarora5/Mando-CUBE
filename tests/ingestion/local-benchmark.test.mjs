import {test} from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkOptions} from '../../scripts/pipeline-local-benchmark.mjs';
const local={PIPELINE_SUPABASE_URL:'http://127.0.0.1:54321',TREG_BUDGET_USD:'0'};
test('local benchmark: bounded defaults and explicit settings',()=>{
  assert.deepEqual(benchmarkOptions([],local),{minutes:20,limit:3,maxNew:25});
  assert.deepEqual(benchmarkOptions(['--minutes','5','--limit','2','--max-new','4'],local),{minutes:5,limit:2,maxNew:4});
});
test('local benchmark: remote, paid and malformed runs fail before connecting',()=>{
  for(const env of [{...local,PIPELINE_SUPABASE_URL:'https://production.supabase.co'},{...local,PIPELINE_ALLOW_REMOTE:'yes'},{...local,TREG_BUDGET_USD:'1'}])assert.throws(()=>benchmarkOptions([],env));
  for(const args of [['--minutes','0'],['--minutes','61'],['--limit','6'],['--max-new','51'],['--unknown','2'],['--minutes']])assert.throws(()=>benchmarkOptions(args,local));
});
