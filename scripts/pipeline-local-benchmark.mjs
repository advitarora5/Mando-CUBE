// Reusable local-only, zero-paid-cost discovery -> jobs -> admission -> scoring benchmark.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {contextFromEnv} from '../src/pipeline/context.ts';
import {runPipeline} from '../src/pipeline/runner.ts';
import {normalizeName,isSimilarName} from '../src/domain/ingestion/normalize.ts';
import {htmlToText,verifyQuote} from '../src/domain/ingestion/quote.ts';

export function benchmarkOptions(argv, env) {
  const options={minutes:20,limit:3,maxNew:25};
  const flags={'--minutes':'minutes','--limit':'limit','--max-new':'maxNew'};
  for(let i=0;i<argv.length;i+=2){
    const key=flags[argv[i]],value=Number(argv[i+1]);
    if(!key||!Number.isInteger(value)||value<1)throw Error('Usage: pipeline:benchmark -- --minutes 20 --limit 3 --max-new 25');
    options[key]=value;
  }
  if(options.minutes>60||options.limit>5||options.maxNew>50)throw Error('Maximums: 60 minutes, 5 sites per batch, 50 new companies');
  if(new URL(env.PIPELINE_SUPABASE_URL??'https://invalid').origin!=='http://127.0.0.1:54321'||env.PIPELINE_ALLOW_REMOTE)throw Error('Benchmark requires local Supabase at http://127.0.0.1:54321 with no remote allowance');
  if(env.TREG_BUDGET_USD!=='0')throw Error('Benchmark requires TREG_BUDGET_USD=0');
  return options;
}

async function benchmark(options,env){
  const ctx=await contextFromEnv(env,{dryRun:false,noLlm:true,maxSpend:0}),store=ctx.store,db=store.db;
  const all=async table=>{
    const rows=[];
    for(let from=0;;from+=1000){
      const r=await db.from(table).select('*').order(table==='company_insights'?'company_id':'id').range(from,from+999);
      if(r.error)throw Error(`${table}: ${r.error.message}`);
      rows.push(...r.data);if(r.data.length<1000)return rows;
    }
  };
  const tables=['companies','contacts','scores','company_insights','weekly_snapshots','outreach_settings','outreach_drafts'];
  const before=Object.fromEntries(await Promise.all(tables.map(async table=>[table,await all(table)])));
  const [reviews,sites,pending]=await Promise.all([store.reviewItems(),store.workdaySites(false),store.pendingCaptures(10000)]);
  const started=new Date(),directory=path.resolve('var/benchmarks',started.toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const save=(file,value)=>fs.writeFileSync(path.join(directory,`${file}.json`),JSON.stringify(value,null,2),{mode:0o600});
  save('baseline',{at:started.toISOString(),tables:before,reviews,sites});
  const sec=JSON.parse(fs.readFileSync(env.PIPELINE_SEC_FILE||'sec.json','utf8'));
  const excluded=new Set([...reviews.map(r=>r.normalized_name),...sites.map(s=>s.normalized_name)]);
  const entries=Object.entries(sec).filter(([,r])=>r?.title&&!excluded.has(normalizeName(r.title))&&!before.companies.some(c=>isSimilarName(c.name,r.title)));
  if(entries.length<100)throw Error('Not enough eligible SEC input');
  save('sec-input',Object.fromEntries(entries));
  process.env.PIPELINE_SEC_FILE=path.join(directory,'sec-input.json');
  ctx.contact=''; // saved SEC snapshot; no live SEC refresh in this benchmark
  const allowed=new Set(entries.map(([,r])=>normalizeName(r.title))),oldSites=new Set(sites.map(s=>s.id)),oldPending=new Set(pending.map(c=>c.id));
  const originalCompanies=store.companies.bind(store),originalReviews=store.reviewItems.bind(store),originalSites=store.workdaySites.bind(store);
  const originalSignals=store.unassignedSignals.bind(store),originalPending=store.pendingCaptures.bind(store),originalSettings=store.settings.bind(store),originalSources=store.sources.bind(store);
  const createdIds=new Set(),oldCompanyIds=new Set(before.companies.map(c=>c.id));
  const state={startedAt:started.toISOString(),options,directory,eligibleSecNames:entries.length,cycles:0,attempts:[],reports:[],companies:[],paidSpend:0,status:'running'};
  const checkpoint=()=>save('summary',state);
  const savedAttempt=store.saveResolverAttempt.bind(store);
  store.saveResolverAttempt=async attempt=>{
    await savedAttempt(attempt);state.attempts.push(attempt);checkpoint();
    console.log(`RESOLVER ${attempt.found?'hit':'miss'} ${attempt.company_name} (${attempt.probes} probes)`);
  };
  store.reviewItems=async status=>(await originalReviews(status)).filter(r=>allowed.has(r.normalized_name));
  store.unassignedSignals=async()=>(await originalSignals()).filter(s=>allowed.has(normalizeName(s.company_name)));
  store.pendingCaptures=async(limit,ids)=>(await originalPending(limit+oldPending.size,ids)).filter(c=>!oldPending.has(c.id)).slice(0,limit);
  store.workdaySites=async enabled=>(await originalSites(enabled)).filter(s=>!oldSites.has(s.id)&&allowed.has(s.normalized_name));
  store.dueResolverAttempts=async()=>[];
  store.settings=async()=>({...await originalSettings(),scoring_scope:'pipeline_only',max_new_companies_per_run:Math.max(0,options.maxNew-createdIds.size)});
  store.sources=async()=>(await originalSources()).map(s=>s.id==='workday-site-resolver'?{...s,max_requests_per_run:Math.min(s.max_requests_per_run,60)}:s);
  const saveCapture=store.saveCapture.bind(store);
  store.saveCapture=async(item,runId)=>saveCapture(item.source==='sec-company-list'?{...item,meta:{...item.meta,test_subset:true,original_rows:Object.keys(sec).length}}:item,runId);
  const create=store.createPipelineCompany.bind(store),admit=store.admitReview.bind(store),score=store.insertScore.bind(store);
  store.createPipelineCompany=async(company,...args)=>{
    if(!allowed.has(normalizeName(company.name))||createdIds.size>=options.maxNew)throw Error('Benchmark admission scope/cap exceeded');
    const id=await create(company,...args);createdIds.add(id);return id;
  };
  store.admitReview=async(...args)=>{const id=await admit(...args);if(!oldCompanyIds.has(id))createdIds.add(id);return id;};
  store.insertScore=async(row,...args)=>{if(!createdIds.has(row.company_id))throw Error('Out-of-scope score blocked');return score(row,...args);};
  for(const method of ['insertContact','updateContact','resolveReview'])store[method]=async()=>{throw Error(`${method} disabled in benchmark`);};
  if(ctx.treg){
    const call=ctx.treg.call.bind(ctx.treg);
    ctx.treg.call=async(endpoint,opts)=>{
      if(!['hunter.x.domain-finder','tinyfish.web.search'].includes(endpoint)||opts.headers?.['X-Treg-Route-Max-Cost']!=='0'||opts.headers?.['X-Treg-Route-Waterfall']!=='0')throw Error('Only explicitly free website lookups allowed');
      return call(endpoint,opts);
    };
  }
  const run=async(plan,source,limit=options.limit)=>{
    const report=await runPipeline(ctx,{plan,source,limit,dryRun:false,trigger:'manual',enrichCompanies:0});
    state.reports.push(report);state.companies=(await originalCompanies()).filter(c=>createdIds.has(c.id));state.paidSpend=ctx.spend.spent('treg');checkpoint();
    if(state.paidSpend!==0)throw Error('Unexpected paid spending');
    return report;
  };
  checkpoint();console.log(`BENCHMARK ${JSON.stringify({directory,minutes:options.minutes,limit:options.limit,maxNew:options.maxNew,baselineCompanies:before.companies.length,eligibleNames:entries.length})}`);
  const sources=await store.sources();
  if(!['sec-company-list','workday-site-resolver','workday-career-sites'].every(id=>sources.some(s=>s.id===id&&s.enabled)))throw Error('Required sources must be enabled');
  const deadline=+started+options.minutes*60000;
  let stop='time window completed';
  try{
    await run('collect','sec-company-list',1);await run('extract');
    while(Date.now()<deadline&&createdIds.size<options.maxNew){
      state.cycles++;console.log(`CYCLE ${state.cycles} ${Math.round((Date.now()-started)/1000)}s elapsed`);
      const priorSites=new Set((await store.workdaySites(true)).map(s=>s.id));
      const discovery=await run('collect','workday-site-resolver');
      await run('extract');
      const freshSites=(await store.workdaySites(true)).filter(s=>!priorSites.has(s.id));
      if(freshSites.length){
        const scoped=store.workdaySites;store.workdaySites=async enabled=>(await scoped(enabled)).filter(s=>freshSites.some(f=>f.id===s.id));
        try{await run('collect','workday-career-sites');}finally{store.workdaySites=scoped;}
        await run('extract');
      }
      const match=await run('match');
      if(createdIds.size){store.companies=async()=>(await originalCompanies()).filter(c=>createdIds.has(c.id));try{await run('score');}finally{store.companies=originalCompanies;}}
      console.log(`PROGRESS ${JSON.stringify({cycles:state.cycles,completedAttempts:state.attempts.length,sitesFound:state.attempts.filter(a=>a.found).length,admitted:createdIds.size,elapsedSeconds:Math.round((Date.now()-started)/1000)})}`);
      if(discovery.jobs.some(j=>j.blocked)||match.jobs.some(j=>j.blocked)){stop='source/provider blocked';break;}
      if(discovery.jobs.every(j=>!j.counts.items&&j.requests===0)){stop='no eligible discovery input';break;}
    }
    if(createdIds.size>=options.maxNew)stop='admission cap reached';
  }catch(error){state.fatalError=error.message;stop='error';}
  state.stopReason=stop;state.finishedAt=new Date().toISOString();
  const after=Object.fromEntries(await Promise.all(tables.map(async t=>[t,await all(t)])));
  state.preservation={};
  for(const table of tables){
    const key=table==='company_insights'?'company_id':'id',rows=new Map(after[table].map(r=>[r[key],r]));
    const unchanged=before[table].every(r=>isDeepStrictEqual(r,rows.get(r[key])));
    const originalIds=new Set(before[table].map(r=>r[key])),additions=after[table].filter(r=>!originalIds.has(r[key]));
    const scopeOkay=table==='companies'?additions.every(r=>createdIds.has(r.id)):table==='scores'?additions.every(r=>createdIds.has(r.company_id)):additions.length===0;
    state.preservation[table]={unchanged,originalRows:before[table].length,additions:additions.length,scopeOkay};
  }
  const laterReviews=await originalReviews();
  state.originalReviewsUnchanged=reviews.every(r=>isDeepStrictEqual(r,laterReviews.find(x=>x.id===r.id)));
  state.reviews=laterReviews.filter(r=>!reviews.some(b=>b.id===r.id));
  state.companies=after.companies.filter(c=>createdIds.has(c.id));state.scores=after.scores.filter(s=>createdIds.has(s.company_id));
  state.evidenceChecks=[];
  for(const company of state.companies)for(const signal of await store.signalsForCompany(company.id)){
    const capture=await store.captureById(signal.capture_id);
    const text=signal.type==='known_customer'?capture.body:htmlToText(JSON.parse(capture.body).jobPostingInfo?.jobDescription??'');
    state.evidenceChecks.push({company:company.name,type:signal.type,confidence:signal.confidence,source:signal.source_url,quoteVerified:verifyQuote(signal.quote,text,signal.type==='known_customer'?1:3).ok});
  }
  state.elapsedSeconds=Math.round((Date.parse(state.finishedAt)-started)/1000);
  state.admittedPerHour=state.elapsedSeconds?Number((state.companies.length*3600/state.elapsedSeconds).toFixed(2)):0;
  const violations=!state.originalReviewsUnchanged||Object.values(state.preservation).some(p=>!p.unchanged||!p.scopeOkay)||state.evidenceChecks.some(e=>!e.quoteVerified)||state.companies.some(c=>!c.name||!c.domain||!/^https:\/\//.test(c.source??'')||!state.scores.some(s=>s.company_id===c.id));
  const failures=state.reports.flatMap(r=>r.jobs).filter(j=>j.status!=='succeeded');
  state.status=violations||state.fatalError||failures.length?'completed_with_errors':'succeeded';checkpoint();
  console.log(`FINAL ${JSON.stringify({status:state.status,stopReason:stop,elapsedSeconds:state.elapsedSeconds,attempts:state.attempts.length,sites:state.attempts.filter(a=>a.found).length,admitted:state.companies.length,reviews:state.reviews.length,scores:state.scores.length,paidSpend:state.paidSpend,admittedPerHour:state.admittedPerHour,originalDataPreserved:!violations,directory})}`);
  if(state.status!=='succeeded')process.exitCode=1;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{await benchmark(benchmarkOptions(process.argv.slice(2),process.env),process.env);}catch(error){console.error(error.message);process.exitCode=1;}
}
