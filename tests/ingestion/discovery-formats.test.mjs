import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeName,tenantCandidates} from '../../src/domain/ingestion/normalize.ts';
import {sitesFromRobots,WorkdayResolver} from '../../src/pipeline/collectors/workday.ts';
import {extractCapture} from '../../src/pipeline/extract.ts';
import {MemoryStore,DEFAULT_SOURCES} from '../../src/pipeline/store/memory.ts';
import {fakeFetch,response,makeCtx} from './helpers.mjs';

test('complete SEC country/state suffixes do not corrupt company names or tenant candidates',()=>{
 for(const suffix of ['/CAN/','/CAN','/DE/','/UK','/ADR']){
  assert.equal(normalizeName(`THOMSON REUTERS CORP ${suffix}`),'thomson reuters');
  assert.equal(tenantCandidates(`THOMSON REUTERS CORP ${suffix}`)[0].tenant,'thomsonreuters');
 }
 assert.equal(normalizeName('North /CAN/ Research'),'north can research');
});
test('PayPal recruiting sitemap maps to the exact tenant/site and extraction keeps the proof',async()=>{
 const body='Sitemap: https://wd1.myworkdaysite.com/recruiting/paypal/jobs/siteMap.xml\nUser-agent: *\nAllow: /jobs/';
 assert.deepEqual(sitesFromRobots(body,'paypal','wd1'),['jobs']);
 const out=await extractCapture({id:'paypal',http_status:200,body,meta:{kind:'workday_robots',tenant:'paypal',pod:'wd1',company_name:'PayPal Holdings Inc',match_kind:'full_name'}},null,'');
 assert.equal(out.sites[0].site,'jobs');assert.equal(out.signals.length,1);assert.equal(out.signals[0].confidence,.95);
});
test('sitemaps from another tenant, pod or lookalike host cannot create a site',()=>{
 for(const url of ['https://wd1.myworkdaysite.com/recruiting/other/jobs/siteMap.xml','https://wd3.myworkdaysite.com/recruiting/paypal/jobs/siteMap.xml','https://wd1.myworkdaysite.com.evil.com/recruiting/paypal/jobs/siteMap.xml','http://wd1.myworkdaysite.com/recruiting/paypal/jobs/siteMap.xml','https://paypal.wd1.myworkdayjobs.com.evil.com/jobs/siteMap.xml'])assert.deepEqual(sitesFromRobots(`Sitemap: ${url}`,'paypal','wd1'),[]);
});
test('default bounded full-name probes reach observed wd503 without corporate fallback',async()=>{
 const store=new MemoryStore(),fetch=fakeFetch([{match:/workiva\.wd503\.myworkdayjobs.com\/robots.txt$/,respond:()=>response(200,'Sitemap: https://workiva.wd503.myworkdayjobs.com/careers/siteMap.xml')},{match:/robots.txt$/,respond:()=>response(422,'unknown tenant')}]);
 const ctx=makeCtx({store,fetch});await store.saveCapture({source:'sec-company-list',url:'https://www.sec.gov/files/company_tickers.json',raw:JSON.stringify({0:{title:'WORKIVA INC'}}),fetched_at:ctx.now().toISOString(),http_status:200,content_type:'application/json',fingerprint:'workiva'},null);
 const result=await new WorkdayResolver().collect(DEFAULT_SOURCES.find(s=>s.id==='workday-site-resolver'),{maxRequests:20,maxItems:1,minDelayMs:1000,dryRun:true},ctx);
 assert.equal(result.items[0].meta.pod,'wd503');assert.ok(result.requests<=7);assert.equal(result.items[0].meta.primary_sites[0],'careers');
});
