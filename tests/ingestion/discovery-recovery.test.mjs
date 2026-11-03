import {test} from 'node:test';
import assert from 'node:assert/strict';
import {primarySites,sitesFromRobots,WorkdayJobs} from '../../src/pipeline/collectors/workday.ts';
import {corporateWorkdayLinks,discoverCorporateCareers} from '../../src/pipeline/collectors/corporate-careers.ts';
import {extractCapture} from '../../src/pipeline/extract.ts';
import {collectStage,extractStage} from '../../src/pipeline/stages.ts';
import {MemoryStore,DEFAULT_SOURCES} from '../../src/pipeline/store/memory.ts';
import {fixture,fakeFetch,response,makeCtx} from './helpers.mjs';
const source=id=>DEFAULT_SOURCES.find(s=>s.id===id);
const limits={maxRequests:50,maxItems:1,minDelayMs:1000,dryRun:false};
const html=name=>`<html><head><meta property="og:site_name" content="${name}"></head><body>`;
const bank=html('Bank of America')+'<a href="https://ghr.wd1.myworkdayjobs.com/en-us/lateral-us/login">Professional Applicants</a></body></html>';
const job={jobPostingInfo:{title:'Workday Engineer',jobDescription:'We maintain our Workday system.'}};

test('saved Shell failure: choose branded ShellCareers despite stale NOVCareers metadata, including existing databases',async()=>{
 const robots=fixture('workday-robots-shell.txt');
 assert.equal(primarySites(sitesFromRobots(robots,'shell','wd3'),'shell')[0],'ShellCareers');
 const store=new MemoryStore(),ctx=makeCtx({store});
 const saved=await store.saveCapture({source:'workday-site-resolver',url:'https://shell.wd3.myworkdayjobs.com/robots.txt',raw:robots,fetched_at:ctx.now().toISOString(),http_status:200,content_type:'text/plain',fingerprint:'shell',meta:{kind:'workday_robots',tenant:'shell',pod:'wd3',company_name:'Shell plc',match_kind:'full_name',primary_sites:['NOVCareers']}},null);
 const extracted=await extractCapture(await store.captureById(saved.id),null,'');assert.equal(extracted.sites[0].site,'ShellCareers');
 await store.upsertWorkdaySite({tenant:'shell',pod:'wd3',site:'NOVCareers',company_name:'Shell plc',normalized_name:'shell',match_kind:'full_name',capture_id:saved.id,discovered_from:'workday-site-resolver'});
 ctx.fetch=fakeFetch([{match:/robots.txt$/,respond:()=>response(200,robots)},{match:/ShellCareers\/jobs$/,respond:()=>response(200,{total:1,jobPostings:[{externalPath:'/job/Test/JR1'}]})},{match:/\/job\//,respond:()=>response(200,job)}]);
 const result=await new WorkdayJobs().collect(source('workday-career-sites'),limits,ctx);
 assert.equal(result.items.length,1);assert.equal(result.items[0].meta.site,'ShellCareers');assert.ok((await store.workdaySites(true)).some(s=>s.site==='ShellCareers'));
 assert.ok(!ctx.fetch.calls.some(c=>c.url.includes('NOVCareers/jobs')));
});

async function alternatives(first){
 const store=new MemoryStore();for(const site of ['Careers','OtherJobs'])await store.upsertWorkdaySite({tenant:'example',pod:'wd5',site,company_name:'Example Inc',normalized_name:'example',match_kind:'full_name',capture_id:null,discovered_from:'x'});
 const fetch=fakeFetch([{match:/robots.txt$/,respond:()=>response(200,'User-agent: *\nAllow: /')},{match:/Careers\/jobs$/,respond:(_url,init)=>first(JSON.parse(init.body))},{match:/OtherJobs\/jobs$/,respond:()=>response(200,{total:1,jobPostings:[{externalPath:'/job/Test/JR1'}]})},{match:/\/job\//,respond:()=>response(200,job)}]);
 return {fetch,result:await new WorkdayJobs().collect(source('workday-career-sites'),limits,makeCtx({store,fetch}))};
}

test('a disabled observed site is never restored or fetched by empty-site recovery',async()=>{
 const store=new MemoryStore(),ctx=makeCtx({store});const robots=fixture('workday-robots-shell.txt');
 const saved=await store.saveCapture({source:'x',url:'https://shell.wd3.myworkdayjobs.com/robots.txt',raw:robots,fetched_at:ctx.now().toISOString(),http_status:200,content_type:'text/plain',fingerprint:'shell'},null);
 for(const site of ['NOVCareers','ShellCareers'])await store.upsertWorkdaySite({tenant:'shell',pod:'wd3',site,company_name:'Shell plc',normalized_name:'shell',match_kind:'full_name',capture_id:saved.id,discovered_from:'x'});
 store.sites.find(s=>s.site==='ShellCareers').enabled=false;
 ctx.fetch=fakeFetch([{match:/robots.txt$/,respond:()=>response(200,robots)},{match:/\/jobs$/,respond:()=>response(200,{total:0,jobPostings:[]})}]);
 await new WorkdayJobs().collect(source('workday-career-sites'),limits,ctx);
 assert.ok(!ctx.fetch.calls.some(c=>c.url.includes('/ShellCareers/')));assert.equal(store.sites.find(s=>s.site==='ShellCareers').enabled,false);
});
test('an unfiltered empty site tries an observed alternative, but no keyword hits and access failures do not',async()=>{
 const empty=await alternatives(()=>response(200,{total:0,jobPostings:[]}));assert.equal(empty.result.items[0].meta.site,'OtherJobs');
 const live=await alternatives(body=>response(200,{total:body.searchText?0:1,jobPostings:body.searchText?[]:[{externalPath:'/job/Test/JR1'}]}));assert.equal(live.result.items.length,0);assert.ok(!live.fetch.calls.some(c=>c.url.includes('OtherJobs')));
 const blocked=await alternatives(()=>response(403,'blocked'));assert.match(blocked.result.blocked,/blocked/);assert.ok(!blocked.fetch.calls.some(c=>c.url.includes('OtherJobs')));
});

test('official links require independent company identity and exact safe Workday URLs; comments and scripts cannot supply evidence',()=>{
 assert.deepEqual(corporateWorkdayLinks(bank,'https://careers.bankofamerica.com/en-us','Bank of America Corp').map(l=>[l.tenant,l.pod,l.site]),[['ghr','wd1','lateral-us']]);
 assert.equal(corporateWorkdayLinks(bank,'https://careers.bankofamerica.com/en-us','Unrelated Bank').length,0);
 for(const href of ['http://ghr.wd1.myworkdayjobs.com/Careers','https://ghr.wd1.myworkdayjobs.com.evil.com/Careers','https://ghr.wd1.myworkdayjobs.com/wday/cxs/other/Careers','https://ghr.wd1.myworkdayjobs.com/Careers%2fOther','https://user:pass@ghr.wd1.myworkdayjobs.com/Careers'])assert.equal(corporateWorkdayLinks(html('Bank of America')+`<a href="${href}">Jobs</a>`,'https://bankofamerica.com','Bank of America').length,0);
 assert.equal(corporateWorkdayLinks(html('Bank of America')+'<!--<a href="https://evil.wd5.myworkdayjobs.com/Careers">Jobs</a>--><script>"<a href=\'https://evil.wd5.myworkdayjobs.com/Careers\'>Jobs</a>"</script>','https://bankofamerica.com','Bank of America').length,0);
});

const officialWorld=()=>fakeFetch([
 {match:/myworkdayjobs.com\/robots.txt$/,respond:()=>response(422,'unknown tenant')},
 {match:/bankofamerica.com\/robots.txt$/,respond:()=>response(200,'User-agent: *\nAllow: /')},
 {match:/^https:\/\/bankofamerica.com\/$/,respond:()=>response(200,html('Bank of America')+'</body></html>',{'content-type':'text/html'})},
 {match:/^https:\/\/careers.bankofamerica.com\/$/,respond:()=>response(200,bank,{'content-type':'text/html'})},
]);
test('resolver discovers the non-name ghr tenant through official pages and extraction keeps it weak pending verification',async()=>{
 const store=new MemoryStore();const ctx=makeCtx({store,fetch:officialWorld()});
 await store.saveCapture({source:'sec-company-list',url:'https://www.sec.gov/files/company_tickers.json',raw:JSON.stringify({0:{title:'Bank of America Corp'}}),fetched_at:ctx.now().toISOString(),http_status:200,content_type:'application/json',fingerprint:'sec'},null);
 const resolver={...source('workday-site-resolver'),config:{corporate_discovery:true,names_per_site:1,full_name_pods:1,first_word_pods:1}};
 const report=await collectStage(ctx,resolver,{limit:1,dryRun:false});assert.equal(report.counts.new_captures,1);
 assert.equal(store.captures.at(-1).body,bank,'corporate evidence is saved exactly as received');
 await extractStage(ctx,{limit:10});const sites=await store.workdaySites(true);assert.equal(sites[0].tenant,'ghr');assert.equal(sites[0].match_kind,'careers_link');assert.equal(store.signals[0].confidence,0.6);
 assert.ok(bank.includes(store.signals[0].quote));assert.equal((await store.companies()).length,0);
});

test('corporate discovery honors shared request limits, rejects off-domain redirects and does not cross a mismatched homepage',async()=>{
 const fetch=officialWorld();const ctx=makeCtx({fetch});const capped=await discoverCorporateCareers(ctx,'Bank of America',['https://bankofamerica.com/'],2);assert.ok(fetch.calls.length<=2);assert.equal(capped.pages.length,0);assert.equal(capped.incomplete,true);
 const wrong=fakeFetch([{match:/robots.txt$/,respond:()=>response(200,'User-agent: *\nAllow: /')},{match:/bankofamerica.com\/$/,respond:()=>response(200,html('Other Company'),{'content-type':'text/html'})}]);
 assert.equal((await discoverCorporateCareers(makeCtx({fetch:wrong}),'Bank of America',['https://bankofamerica.com/'],10)).pages.length,0);assert.ok(!wrong.calls.some(c=>c.url.includes('careers.bankofamerica')));
 const redirect=fakeFetch([{match:/robots.txt$/,respond:()=>response(200,'User-agent: *\nAllow: /')},{match:/^https:\/\/bankofamerica.com\/$/,respond:()=>response(200,html('Bank of America'),{'content-type':'text/html'})},{match:/careers.bankofamerica.com\/$/,respond:()=>response(302,'',{'location':'https://attacker.com/'})},{match:/attacker.com\/$/,respond:()=>response(200,bank,{'content-type':'text/html'})}]);
 assert.equal((await discoverCorporateCareers(makeCtx({fetch:redirect}),'Bank of America',['https://bankofamerica.com/'],10)).pages.length,0);
});
