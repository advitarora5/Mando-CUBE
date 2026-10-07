import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, planContacts, importContacts, main, readContacts } from '../scripts/import-contacts.mjs';
const companies = [{id:'company-1',name:'Example Inc.'}];
const candidate = (extra = {}) => ({company:'  EXAMPLE   Inc. ', action:'Candidate', original_notes:'Original qualification', candidate:{name:'Alex Rivera, JD',title:'Chief People Officer',linkedin_url:null,source:null,mutual_connection:null,...extra}});
test('single-person prose retains credentials and never invents links or mutuals', () => {
 const result=parseTarget('Example Inc.','Alex Rivera, JD, Chief People Officer, Example Inc.');
 assert.equal(result.candidate.name,'Alex Rivera, JD');
 assert.equal(result.candidate.title,'Chief People Officer');
 assert.equal(result.candidate.linkedin_url,null);
 assert.equal(result.candidate.source,null);
 assert.equal(result.candidate.mutual_connection,null);
 assert.equal(result.action,'Needs review');
});
test('multi-person, qualified, title-only, and unverified prose is not approved', () => {
 for(const text of ['Alex Rivera, VP HR, and Taylor Doe, CIO, Example Inc.','Alex Rivera, VP HR, Example Inc. (procurement only)','An unverified Alex Rivera, VP HR','No current named HR leader identified — target title: VP HR']) {
  const p=parseTarget('Example Inc.',text); assert.ok(['Needs review','No named person'].includes(p.action)); assert.equal(p.candidate,undefined);
 }
});
test('company matching rejects unmatched and multiple normalized matches', () => {
 assert.equal(planContacts([candidate()],[],[])[0].action,'Needs review');
 assert.equal(planContacts([candidate()],[...companies,{id:'other',name:'example inc.'}],[])[0].action,'Needs review');
});
test('input duplicates collapse; conflicting fields and shared profiles require review', () => {
 const p=planContacts([candidate(),candidate()],companies,[]);
 assert.deepEqual(p.map(i=>i.action),['Add','Preserve existing']);
 assert.ok(planContacts([candidate(),candidate({title:'Different'})],companies,[]).every(i=>i.action==='Needs review'));
 const link='https://www.linkedin.com/in/synthetic';
 assert.ok(planContacts([candidate({linkedin_url:link}),candidate({name:'Taylor Doe',linkedin_url:link})],companies,[]).every(i=>i.action==='Needs review'));
});
test('stable identity ignores changed titles, sources, credentials; preserves team edits', () => {
 const first=planContacts([candidate()],companies,[])[0];
 const changed=candidate({name:'Alex Rivera',title:'New title',source:'https://example.com/new'});
 assert.equal(planContacts([changed],companies,[])[0].id,first.id);
 const edited={id:first.id,company_id:'company-1',name:'Alex R.',title:'Team title',source:'https://example.com/team',linkedin_url:null};
 const before=structuredClone(edited);
 assert.equal(planContacts([changed],companies,[edited])[0].action,'Preserve existing');
 assert.deepEqual(edited,before);
});
test('conflicting existing profiles, names, and multiple matches require review', () => {
 const contact={id:'manual',company_id:'company-1',name:'Alex Rivera',linkedin_url:'https://www.linkedin.com/in/old'};
 assert.equal(planContacts([candidate({linkedin_url:'https://www.linkedin.com/in/new'})],companies,[contact])[0].action,'Needs review');
 assert.equal(planContacts([candidate()],companies,[contact,{...contact,id:'second'}])[0].action,'Needs review');
 assert.equal(planContacts([candidate({name:'Taylor Doe',linkedin_url:contact.linkedin_url})],companies,[contact])[0].action,'Needs review');
});
test('preview never writes; apply/repeat use insert-only conflict handling and preserve team fields', async () => {
 const contacts=[]; let writes=0;
 const db={from(table){return {select(){return this;},order(){return this;},async range(){return {data:table==='companies'?companies:contacts,error:null};},async upsert(rows,options){
  assert.deepEqual(options,{onConflict:'id',ignoreDuplicates:true}); writes++;
  for(const row of rows) if(!contacts.some(c=>c.id===row.id))contacts.push(structuredClone(row));
  return {error:null};
 }}}};
 await importContacts(db,[candidate()]); assert.equal(writes,0);
 await importContacts(db,[candidate()],true); assert.equal(writes,1);
 contacts[0].title='Team-maintained';
 await importContacts(db,[candidate()],true); assert.equal(writes,1); assert.equal(contacts[0].title,'Team-maintained');
});
test('offline apply and invalid flags fail before reading configuration', async () => {
 await assert.rejects(main(['file.csv','--offline','--apply']),/Usage/);
 await assert.rejects(main(['file.csv','--unknown']),/Usage/);
});

test('reviewed CSV validates approval, URLs, and original qualification context offline', async () => {
 const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'contact-test-'));
 try {
  const file=join(dir,'reviewed.csv');
  writeFileSync(file,'company,name,title,approved,original_notes,linkedin_url,source,mutual_connection\nExample Inc.,Alex Rivera,Chief People Officer,yes,Procurement qualification retained,,https://example.com/person,\nExample Inc.,Taylor Doe,VP HR,no,Original note,,,\nExample Inc.,Jordan Doe,VP HR,yes,Unverified directory,,,\nExample Inc.,Casey Doe,VP HR,yes,Original note,https://linkedin.com/company/example,,\n');
  const rows=readContacts(file,true);
  assert.equal(rows[0].action,'Candidate');
  assert.equal(rows[0].original_notes,'Procurement qualification retained');
  assert.equal(rows[0].candidate.mutual_connection,null);
  assert.ok(rows.slice(1).every(r=>r.action==='Needs review'));
 } finally { rmSync(dir,{recursive:true}); }
});
