import { RUBRIC_VERSION } from '../src/domain/scoring/rubric.ts';
import { buildAssessment } from '../src/domain/scoring/assessment.ts';
import { displayTier, incompleteCategories } from '../src/domain/scoring/display.ts';
import { formatEvidence } from '../src/domain/scoring/evidence.ts';

export const TEAM_RUBRIC_VERSION='mando-public-evidence-v4:screenshot-timing-release-20261012';
const roleBases=[0,5,10,15,18,20,22];
function pastDate(today,months){
  const [y,m,d]=today.split('-').map(Number);
  const first=new Date(Date.UTC(y,m-1-months,1));
  const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  first.setUTCDate(Math.min(d,last));return first.toISOString().slice(0,10);
}
function validDate(date){return /^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date).toISOString().slice(0,10)===date;}
function inside(event,from,to){
  if(!event||!validDate(event.start)||!validDate(event.end)||event.start>event.end)throw new Error('Evidence needs real ordered date bounds.');
  return event.start>=from&&event.end<=to;
}
function sourced(source,reason){if(!source?.startsWith('https://')||!formatEvidence(source,reason))throw new Error('Awarded evidence needs an HTTP(S) source and reason.');}

export function contactAuthority(contact,workforce){
  if(!roleBases.includes(contact.role_base))throw new Error('Unsupported Authority role band.');
  sourced(contact.role_source,contact.role_reason);
  const base=contact.current===true?contact.role_base:contact.role_base>0?5:0;
  const eligible=contact.current===true&&base>0;
  const size=eligible&&workforce.threshold_verified===true?3:0;
  const ownership=eligible&&contact.workday_owner===true?2:0;
  if(size)sourced(workforce.source,workforce.reason);
  if(ownership)sourced(contact.ownership_source,contact.ownership_reason);
  return {contact:contact.name,score:Math.min(25,base+size+ownership),base,size,ownership,
    source:contact.role_source,reason:`${contact.name}: ${contact.role_reason} Role ${base} + confirmed 3,000+ employer/group ${size} + explicit individual Workday responsibility ${ownership}, capped at 25.`,
    sources:[contact.role_source,...(size?[workforce.source]:[]),...(ownership?[contact.ownership_source]:[])],
    missing:[...(!eligible?['Current relevant role is unconfirmed; no bonuses.']:[]),...(eligible&&workforce.threshold_verified!==true?['Not enough evidence to confirm the matching 3,000+ workforce threshold.']:[]),...(eligible&&!ownership?['No explicit individual Workday-program ownership bonus supported.']:[])]};
}

export function contactReachability(contact,today){
  const channels=contact.channels.filter(c=>c.supported===true);
  for(const channel of channels)sourced(channel.source,channel.reason);
  const personal=channels.filter(c=>['email','phone','linkedin'].includes(c.type));
  const named=personal.find(c=>['email','phone'].includes(c.type));
  const linkedin=personal.find(c=>c.type==='linkedin');
  const usable=linkedin?.messaging_confirmed===true;
  const general=channels.find(c=>c.type==='general');
  const base=named||usable?15:linkedin?10:general?5:0;
  const eligible=contact.current===true&&contact.role_base>0&&base>=10;
  const second=eligible&&new Set(personal.map(c=>c.type)).size>1?3:0;
  const verified=eligible&&personal.some(c=>c.verified===true&&c.verification_source&&c.verification_checked_on)?2:0;
  if(verified)for(const c of personal.filter(c=>c.verified===true))sourced(c.verification_source,'Deliverability/live-phone verification provenance');
  const initiatives=(contact.initiatives||[]).filter(e=>inside(e,pastDate(today,24),today));
  const initiative=eligible&&initiatives.length?3:0;
  const active=(contact.active_actions||[]).filter(e=>e.active===true&&inside(e,pastDate(today,12),today)&&!initiatives.some(i=>i.activity_id===e.activity_id));
  const action=eligible&&active.length?2:0;
  for(const e of [...initiatives,...active])sourced(e.source,e.reason);
  const intro=eligible&&contact.introduction?.confirmed_by&&contact.introduction?.confirmed_on&&contact.introduction?.willing===true?5:0;
  if(intro&&!contact.introduction.provenance_ref)throw new Error('A private introduction needs real recorded provenance, never a fabricated public URL.');
  const source=named?.source||linkedin?.source||general?.source||null;
  return {contact:contact.name,score:Math.min(25,base+second+verified+initiative+action+intro),base,second,verified,initiative,action,introduction:intro,source,
    reason:`${contact.name}: sourced route ${base} + second personal channel ${second} + evidenced deliverability/live phone ${verified} + dated personal initiative ${initiative} + distinct active Workday action ${action} + confirmed willing introduction ${intro}, capped at 25. No messaging access or buying intent inferred.`,
    sources:[...channels.map(c=>c.source),...(initiative?initiatives.map(e=>e.source):[]),...(action?active.map(e=>e.source):[])],
    missing:[...(contact.unsourced_database_email?['Database email/verified flag has no source or verifier provenance; excluded from publication/channel/verification points.']:[]),...(!verified?['Named deliverability or live-phone verification is unconfirmed.']:[]),...(!initiative?['No dated personal HR-tech/Workday initiative bonus established.']:[]),...(!action?['No separately evidenced active Workday action bonus established.']:[]),...(!intro?['No team-confirmed willing introduction; optional, not a gate.']:[])]};
}

export function budgetScore(financial,technology,today){
  if(financial.freeze===true&&financial.funded_exception!==true)return {score:0,capacity:0,investment:0,status:'not_met',source:financial.freeze_source,reason:'Explicit current freeze of the relevant project; no funded exception.',missing:[]};
  if(financial.funded_rfp===true){sourced(financial.funded_source,financial.funded_reason);return {score:20,capacity:null,investment:null,status:'met',source:financial.funded_source,reason:financial.funded_reason,missing:[]};}
  if(![true,false,null].includes(financial.positive_operating))throw new Error('Financial operating result needs a reviewed state.');
  const capacity=financial.positive_operating===true?10+(financial.revenue_growth===true?1:0)+(financial.operating_growth===true?1:0):0;
  if(financial.positive_operating!==null)sourced(financial.source,financial.reason);
  let best={score:0,source:null,reason:'Not enough evidence to confirm an eligible technology investment.'};
  for(const t of technology){
    sourced(t.source,t.reason);
    if(!['deployment','modernization','historical'].includes(t.kind))throw new Error('Invalid investment kind.');
    const recent=t.kind==='deployment'&&t.internal===true&&t.deployment&&inside(t.deployment,pastDate(today,24),today);
    const points=recent?8:t.kind==='modernization'&&t.active===true?6:t.internal===true?3:0;
    if(points>best.score)best={score:points,source:t.source,reason:t.reason};
  }
  const missing=[...(financial.positive_operating===null?['Not enough evidence to confirm latest entity-matched annual operating income/surplus.']:[]),...(best.score===0?['Not enough evidence to confirm eligible investment; a logo, partnership, client work or services alone is insufficient.']:[])];
  return {score:Math.min(20,capacity+best.score),capacity,investment:best.score,status:missing.length?'partial':'met',source:capacity?financial.source:best.source,
    reason:`Financial capacity ${capacity}/12 (${financial.reason}) + highest supported technology proxy ${best.score}/8 (${best.reason}), capped at 20. Reported annual metrics used; revenue/operating-growth bonuses apply only with positive operations. This is a proxy, not funds committed to Mando.`,missing,
    sources:[...(financial.source?[financial.source]:[]),...(best.source?[best.source]:[])]};
}

export function timingScore(company,today){
  const candidates=[];
  for(const e of company.timing_events){
    sourced(e.source,e.reason);
    if(e.kind==='expansion'&&e.active===true&&validDate(e.milestone_end)&&e.milestone_end>=today&&e.milestone_end<=pastDate(today,-6))candidates.push({...e,score:15});
    else if(e.kind==='completed_go_live'&&inside(e,pastDate(today,6),today))candidates.push({...e,score:12});
    else if(e.kind==='rollout'&&inside(e,pastDate(today,12),today))candidates.push({...e,score:10});
    else if(e.kind==='leadership_or_hiring'&&inside(e,pastDate(today,12),today))candidates.push({...e,score:8});
  }
  const best=candidates.sort((a,b)=>b.score-a.score)[0];
  if(best)return {...best,status:'met',missing:['No overlapping timing signals added; only the highest supported trigger is used.']};
  if(company.workday.current===true)return {score:5,status:'met',source:company.workday.source,reason:'Confirmed ongoing Workday operation: five-point operational-opportunity baseline only; this does not prove urgency.',missing:['Not enough evidence to confirm a stronger dated trigger.']};
  return {score:0,status:'unknown',source:company.workday.source,reason:'Selection alone or unconfirmed current operation; no supported scheduled implementation.',missing:['Not enough evidence to confirm current deployment or an eligible dated trigger.']};
}

export function releaseScore(company,today){
  if(company.workday.current!==true)return {score:0,status:'unknown',source:company.workday.source,reason:'Current deployment/release applicability is unconfirmed.',missing:['Not enough evidence to confirm current Workday operation.']};
  // A confirmed current Workday customer is NOT release-preparation evidence on its own.
  // Points are only awarded when a CONFIRMED upcoming release date lands in the
  // readiness window (42-126 days). 8 is never a default; calendar estimates don't count.
  const next=company.release.next_confirmed_date;
  let score=0,status='unknown';
  if(next){
    if(!validDate(next))throw new Error('Confirmed release date is invalid.');
    const days=(Date.parse(next)-Date.parse(today))/86400000;
    if(days>=42&&days<=84)score=company.release.documented_preparation===true?15:12;
    else if(days>=84&&days<=126)score=10;
  }
  if(score>0)status='met';
  const missing=score===0?['Confirmed as a current Workday customer, but no confirmed upcoming release date within the readiness window (42-126 days); recurring-feature applicability alone does not earn release score.']:['No additional release-preparation signals beyond the confirmed date.'];
  const reason=score===0?'Confirmed current Workday customer with no confirmed upcoming release date in the readiness window (42-126 days). A current-customer status is not release-preparation evidence; calendar estimates do not count as confirmed dates.':`Confirmed upcoming release at ${next} (${Math.round((Date.parse(next)-Date.parse(today))/86400000)} days out, readiness window 42-126 days): ${score}/15. Documented preparation: ${company.release.documented_preparation===true?'yes':'no'}.`;
  return {score,status,source:company.workday.source,reason,missing,sources:[company.workday.source,company.release.policy_source].filter(Boolean)};
}

export function assessTeamCompany(company,today){
  if(!validDate(today)||!company.contacts.length)throw new Error('A valid assessment day and reviewed contact candidates are required.');
  const authorityCandidates=company.contacts.map(c=>contactAuthority(c,company.workforce));
  const reachCandidates=company.contacts.map(c=>contactReachability(c,today));
  const authority=[...authorityCandidates].sort((a,b)=>b.score-a.score)[0];
  const reach=[...reachCandidates].sort((a,b)=>b.score-a.score)[0];
  const budget=budgetScore(company.financial,company.technology,today);
  const release=releaseScore(company,today),timing=timingScore(company,today);
  const detail={authority:{...authority,status:authority.score?'met':'unknown'},reachability:{...reach,status:reach.base?'met':'unknown'},budget,release,timing};
  const inputs=Object.fromEntries(Object.entries(detail).map(([key,e])=>[key,{score:e.score,source:e.source,reason:`Evidence: ${e.reason} Assessment status: ${e.status}. Missing: ${e.missing.join(' ')||'None for this scoring level'}. Additional sources: ${(e.sources||[]).filter(s=>s!==e.source).join('; ')||'None'}.`}]));
  const result=buildAssessment(company.company_id,inputs);
  if(!result.ok)throw new Error(result.errors.join(' '));
  // Unsourced zeroes carry the gap text with no fabricated URL; they remain incomplete.
  for(const [key,e] of Object.entries(inputs))if(!e.source)result.row[key+'_evidence']=e.reason;
  result.row.rubric_version=`${RUBRIC_VERSION}:${TEAM_RUBRIC_VERSION}`;
  return {...result,display_tier:displayTier(result.row),unresolved_categories:incompleteCategories(result.row),detail,authorityCandidates,reachCandidates};
}
