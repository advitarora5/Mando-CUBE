import fs from 'node:fs';import {createHash} from 'node:crypto';
import {MemoryStore} from '../src/pipeline/store/memory.ts';
import {contextFromEnv} from '../src/pipeline/context.ts';
import {runPipeline} from '../src/pipeline/runner.ts';
import {normalizeName} from '../src/domain/ingestion/normalize.ts';
const dir=`var/discovery-comparison-${new Date().toISOString().replace(/[:.]/g,'-')}`;fs.mkdirSync(dir,{recursive:true});
if(fs.existsSync(`${dir}/summary.json`))throw Error('Comparison already started; inspect before rerunning');
const save=(name,value)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const selected=JSON.parse(fs.readFileSync('research/discovery-20-2026-11-02/selected-sec.json'));
const allowed=new Set(Object.values(selected).map(x=>normalizeName(x.title)));
const store=new MemoryStore();const ctx=await contextFromEnv({}, {dryRun:true,store,noLlm:true,noTreg:true,maxSpend:0});
const sources=store.sources.bind(store);store.sources=async()=>(await sources()).map(s=>s.id==='workday-site-resolver'?{...s,config:{...s.config,names_per_site:1,corporate_discovery:true}}:s);
const attempts=store.resolverAttempts.bind(store);store.resolverAttempts=async names=>{const out=await attempts(names);for(const name of names)if(!allowed.has(name))out.add(name);return out;};store.dueResolverAttempts=async()=>[];
const state={started_at:new Date().toISOString(),mode:'Live HTTP with isolated MemoryStore; no real database writes',selected:Object.values(selected).map(x=>x.title),selected_sha256:createHash('sha256').update(fs.readFileSync('research/discovery-20-2026-11-02/selected-sec.json')).digest('hex'),configuration:{corporate_discovery:true,configured_corporate_websites:false,website_lookup_service:false,names_per_site:1,site_limit:20,request_cap:500,admission_rules:'unchanged',identity:'unchanged; shadow only'},reports:[],attempts:[]};
const saveAttempt=store.saveResolverAttempt.bind(store);store.saveResolverAttempt=async a=>{state.attempts.push(a);save('summary',state);console.log(JSON.stringify({completed:a.company_name,found:a.found,probes:a.probes}));return saveAttempt(a);};
process.env.PIPELINE_SEC_FILE='sec.json';save('summary',state);
for(const [plan,source] of [['collect','sec-company-list'],['extract'],['collect','workday-site-resolver'],['extract'],['collect','workday-career-sites'],['extract'],['match']]){
 const r=await runPipeline(ctx,{plan,source,limit:20,dryRun:false,trigger:'manual'});state.reports.push(r);save('summary',state);console.log(JSON.stringify({plan,source,jobs:r.jobs.map(j=>({status:j.status,counts:j.counts,errors:j.errors}))}));
 if(r.jobs.some(j=>j.blocked)){state.stop_reason='source blocked';break;}
}
state.finished_at=new Date().toISOString();state.sites=await store.workdaySites(false);state.companies=await store.companies();state.reviews=await store.reviewItems();
state.counts={selected:allowed.size,completed_attempt_records:state.attempts.length,found_names:new Set(state.sites.map(s=>s.normalized_name)).size,sites:state.sites.length,job_captures:store.captures.filter(c=>c.meta?.kind==='workday_job').length,admitted:state.companies.length,held:state.reviews.filter(r=>r.status==='pending').length};
save('captures',store.captures);save('signals',store.signals);save('summary',state);console.log(JSON.stringify({finished:true,counts:state.counts}));
