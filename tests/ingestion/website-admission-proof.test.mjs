import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebsiteHttp, resolveWebsite } from '../../src/pipeline/website.ts';
import { matchStage } from '../../src/pipeline/stages.ts';
import { makeCtx, fakeFetch, fakeTreg, response } from './helpers.mjs';

const cerenceSite={id:'site',tenant:'cerence',pod:'wd5',site:'Cerence',normalized_name:'cerence',match_kind:'full_name',enabled:true};
const board='https://cerence.wd5.myworkdayjobs.com/en-US/Cerence';
function fixture({name='Cerence Inc.',domains=['cerence.com'],pages={},sites=[cerenceSite]}={}){
  const ctx=makeCtx({fetch:fakeFetch([
    {match:/\/robots\.txt$/,respond:()=>response(404,'')},
    {match:/^https:\/\//,respond:url=>pages[url] instanceof Response ? pages[url].clone() : pages[url] ? response(200,pages[url],{'content-type':'text/html'}) : response(404,'')},
  ]),treg:fakeTreg({
    'hunter.x.domain-finder':()=>({ok:true,status:200,cost_usd:0,body:{data:domains.map(domain=>({domain,company_name:name}))}}),
    'tinyfish.web.search':()=>({ok:true,status:200,cost_usd:0,body:{results:[]}}),
  })});
  return {ctx,resolve:(refs=[])=>resolveWebsite(ctx,name,sites,new WebsiteHttp(ctx),false,refs)};
}
test('documented Cerence AI branding plus an exact careers link confirms the corporate domain',async()=>{
  const f=fixture({pages:{'https://cerence.com/':'<title>Cerence AI | AI for a World in Motion</title><a href="/about/careers">Careers</a>',
    'https://cerence.com/about/careers':`<a href="${board}">View open positions</a>`}});
  const r=await f.resolve();assert.equal(r.status,'confirmed');assert.equal(r.domain,'cerence.com');
  assert.equal(r.evidence.checks[0].identity,'Cerence AI');assert.equal(r.evidence.checks[0].workday_url,board);
});
test('branding does not waive the domain, issuer, or exact Workday site requirements',async()=>{
  for(const config of [
    {domains:['unrelated.example'],pages:{'https://unrelated.example/':`<title>Cerence AI</title><a href="${board}">Careers</a>`}},
    {name:'Cerence Investment Fund',pages:{'https://cerence.com/':`<title>Cerence AI</title><a href="${board}">Careers</a>`}},
    {pages:{'https://cerence.com/':'<title>Cerence AI</title><a href="https://cerence.wd5.myworkdayjobs.com/WrongSite">Careers</a>'}},
    {pages:{'https://cerence.com/':`<title>Welcome</title><p>Cerence AI</p><a href="${board}">Careers</a>`}},
  ])assert.notEqual((await fixture(config).resolve()).status,'confirmed');
});
test('fresh Cerence proof recovers a website review once; human similar-name review stays protected',async()=>{
  for(const reason of ['no_website','similar_name']){
    const f=fixture({pages:{'https://cerence.com/':`<title>Cerence AI</title><a href="${board}">Careers</a>`}});
    const review=await f.ctx.store.addReviewItem({candidate_name:'Cerence Inc.',normalized_name:'cerence',candidate_domain:null,employee_count:null,suggested_company_id:null,reason});
    f.ctx.store.sites.push({...cerenceSite,company_name:'Cerence Inc.',company_id:null,review_item_id:review.id,capture_id:'robots'});
    await f.ctx.store.upsertSignal({company_id:null,review_item_id:review.id,capture_id:'robots',extraction_id:null,type:'known_customer',signal_date:null,source_url:board,quote:'Workday careers',confidence:0.8,company_name:'Cerence Inc.',products:null,project_type:null,role_seniority:null,timing_words:null,method:'structured',seen_at:f.ctx.now().toISOString()});
    const r=await matchStage(f.ctx);
    assert.deepEqual(r.errors,[]);
    if(reason==='no_website'){
      assert.equal(r.counts.new_companies,1);assert.equal(f.ctx.store.companyRows[0].domain,'cerence.com');
      await matchStage(f.ctx);assert.equal(f.ctx.store.companyRows.length,1);
    }else{
      assert.equal(f.ctx.store.companyRows.length,0);assert.equal(f.ctx.store.reviews[0].status,'pending');
      assert.equal(f.ctx.store.reviews[0].candidate_domain,'cerence.com');
    }
  }
});
function rimini({linked=true,other='investors.riministreet.com'}={}){
  const refs=['riministreet.com',other].map(domain=>({domain,url:`https://${domain}/`,source_url:'https://riministreet.wd1.myworkdayjobs.com/wday/cxs/riministreet/RiminiStreet/job/fixture',capture_id:'fixture',field:'jobPostingInfo.jobDescription'}));
  const f=fixture({name:'Rimini Street, Inc.',domains:[],sites:[{...cerenceSite,tenant:'riministreet',pod:'wd1',site:'RiminiStreet',normalized_name:'rimini street'}],pages:{
    'https://riministreet.com/':`<title>Rimini Street</title>${linked?`<a href="https://${other}/investor-relations">Investors</a>`:''}`,
    [`https://${other}/`]:'<title>Rimini Street, Inc.</title>',
  }});return {...f,refs};
}
test('independently verified, explicitly linked investor subdomain does not create a false website conflict',async()=>{
  const f=rimini();const r=await f.resolve(f.refs);
  assert.equal(r.status,'confirmed');assert.equal(r.domain,'riministreet.com');
  assert.equal(r.evidence.checks.filter(c=>c.employer_link).length,2,'retain both underlying proofs');
});
test('unlinked subdomains and unrelated domains still require review',async()=>{
  for(const config of [{linked:false},{other:'different.example'}]){
    const f=rimini(config);const r=await f.resolve(f.refs);assert.equal(r.status,'unresolved');assert.match(r.reason,/multiple websites/);
  }
});
test('shared security proxy links are not fetched as corporate website candidates',async()=>{
  const f=fixture({domains:[],pages:{}});
  const r=await f.resolve([{domain:'mcas-proxyweb.mcas.ms',url:'https://mcas-proxyweb.mcas.ms/certificate-checker',source_url:'https://cerence.wd5.myworkdayjobs.com/wday/cxs/cerence/Cerence/job/fixture',capture_id:'fixture',field:'jobPostingInfo.jobDescription'}]);
  assert.notEqual(r.status,'confirmed');assert.ok(f.ctx.fetch.calls.every(c=>!c.url.includes('mcas.ms')));
});
test('valid 307 redirects are followed and destination robots are checked; missing Location is explicit',async()=>{
  const f=fixture({pages:{'https://cerence.com/':response(307,'',{location:'https://www.cerence.com/'}),'https://www.cerence.com/':'<title>Cerence AI</title>'}});
  assert.equal((await new WebsiteHttp(f.ctx).page('https://cerence.com/')).url,'https://www.cerence.com/');
  assert.ok(f.ctx.fetch.calls.some(c=>c.url==='https://www.cerence.com/robots.txt'));
  const missing=fixture({pages:{'https://cerence.com/':response(307,'')}});
  await assert.rejects(new WebsiteHttp(missing.ctx).page('https://cerence.com/'),/redirect HTTP 307 has no Location header/);
});
