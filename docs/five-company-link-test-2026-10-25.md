# Five-candidate Workday ownership test — October 25, 2026

## Outcome

The pipeline found five Workday tenant candidates after 41 completed company searches and
312 robots.txt probes. Independent inspection confirmed three employer matches and found two
incorrect first-word matches. Of the three correct matches, all had explicit corporate/Workday
links available in saved postings or official pages. This sample therefore does **not** demonstrate
that removing the link requirement would solve the observed failures.

Gilead passed automated website confirmation. Marvell and Abbott failed for access/parser reasons,
not absence of linking evidence. Western Digital and Intuitive Surgical were associated with
unrelated employers' Workday sites. Finding their real corporate websites does not validate those
tenant associations.

This changes the earlier suggestion to remove the explicit-link requirement outright: ownership
verification is necessary, although a direct link could remain one of several acceptable proofs
once alternative criteria are implemented and tested.

## Results by candidate

| SEC company requested | Discovered Workday tenant/site | Independent employer check | Explicit link evidence | Automated website result |
| --- | --- | --- | --- | --- |
| Marvell Technology, Inc. | `marvell.wd1/MarvellCareers` | Correct | Saved posting links to `marvell.com`; official careers page links to the exact Workday site | Error: robots response rejected as unreadable; alternative suggestions also failed |
| Gilead Sciences, Inc. | `gilead.wd1/gileadcareers` | Correct | Saved posting links to `gilead.com` benefits; official careers page also links to the exact site | Confirmed `gilead.com` |
| Abbott Laboratories | `abbott.wd5/abbottcareers` | Correct | Saved postings link to `abbott.com`; official careers page links to this tenant/site's application login | Error: corporate identity not recognized; other candidates had access/DNS failures |
| Western Digital Corp | `western.wd1/WESTERN` | **Wrong: Western Colorado University** | University's official careers page links to the discovered site | Error; no verified Western Digital ownership |
| Intuitive Surgical Inc. | `intuitive.wd1/irtc_careers` | **Wrong: Intuitive Research and Technology Corporation** | That engineering firm's official careers page links to the discovered site | Error; no verified Intuitive Surgical ownership |

The last two findings do not establish whether Western Digital or Intuitive Surgical use Workday
elsewhere. They establish that the particular discovered sites cannot be attributed to those SEC
companies. Five resolver hits are not five verified company matches.

## Source inspection

- [Marvell careers](https://www.marvell.com/company/careers.html) links through “See All Jobs” to
  [MarvellCareers](https://marvell.wd1.myworkdayjobs.com/MarvellCareers).
  Its one collected posting links to `https://www.marvell.com/company/careers/` and identifies
  Marvell Semiconductor Canada as the hiring organization.
- [Gilead opportunities](https://www.gilead.com/careers/opportunities) links to
  [gileadcareers](https://gilead.wd1.myworkdayjobs.com/gileadcareers) and identifies Workday as its
  application portal. Saved jobs include Gilead Sciences entities. A Workday Solutions Architect
  posting links to Gilead's benefits page; corporate homepage identity independently matches.
- [Abbott careers](https://www.abbott.com/en-us/careers) links through “Application Status” to
  `https://abbott.wd5.myworkdayjobs.com/abbottcareers/login`. Its collected jobs identify Abbott
  Laboratories and related entities and include corporate-domain links.
- [Western Colorado University careers](https://western.edu/about/directory/human-resources/careers-at-western/)
  links through “View Careers” to `https://western.wd1.myworkdayjobs.com/WESTERN`.
- [Intuitive Research and Technology careers](https://irtc-hq.com/careers/)
  links through “View Job Openings” to `https://intuitive.wd1.myworkdayjobs.com/irtc_careers`.

These manual source inspections were kept separate from the automatic pipeline results; they
were not injected as confirmed websites or used to force admission.

## Concrete failure causes

1. **First-word discovery can identify the wrong employer.** All five sites were found through
   first-word guesses, initially confidence 0.6. `western` and `intuitive` collide with unrelated
   organizations. A valid robots.txt response proves a tenant exists, not who owns it.
2. **Abbott identity parsing is incomplete.** Saved public HTML from its homepage contains
   JSON-LD with `"@type": "Corporation"` and `"name": "Abbott Laboratories"`.
   `pageIdentity()` currently recognizes only `Organization`, so it misses this explicit identity.
   It also does not accept the brand “Abbott” as automatically equivalent to “Abbott Laboratories.”
3. **Marvell access remains a real obstacle.** The verifier rejected a robots response as unreadable
   HTML despite HTTP 200. A separate follow-up request following redirects returned 403. The
   official careers page and saved job demonstrate the link exists; no access restriction was bypassed.
4. **Search retrieves useful candidates but also noise.** TinyFish fallback ran for four candidates
   and returned relevant corporate/careers domains as well as job boards. Gilead confirmed without
   needing search. Matching result titles alone would not fix wrong tenant attribution.
5. **Unrelated candidate errors can still veto confirmation.** Abbott's lookup also contains
   timeouts/unreadable alternatives. Recognizing its `Corporation` schema alone may not remove
   every blocker: source-backed candidates discovered by search need the same prioritization as
   source-backed Hunter candidates, with explicit handling of contradictory versus unrelated results.

## Admission comparison

No matching/admission, scoring, contact enrichment, or review-decision stage was executed.
An offline call to the existing pure matching function, using the saved results and assuming room
under the admission cap, classified Gilead as `create` and the other four as `review/no_website`.
This is a decision preview, not a successful database admission or score.

Gilead and Abbott each had fresh confidence-0.9 hiring evidence. Marvell's career-site and one
hiring signal both remained 0.6, so it would still require stronger evidence under current rules
even if website confirmation were fixed. Western and Intuitive yielded no matching job postings
in the configured Workday search and only the weak career-site signals.

## Execution and data preservation

- Ran locally on October 25, America/Chicago; timestamps are October 26 UTC.
- Elapsed discovery/collection/confirmation time: **447.8 seconds** (about 7.5 minutes).
- Saved SEC list, filtered to 10,276 names absent from existing companies/reviews/sites.
  No fresh SEC download was tested.
- Two discovery calls returned three and then two sites. The second call stopped at the target:
  41 company searches completed, rather than all 42 names offered to the two batches.
- Collected **17 jobs**: Marvell 1, Gilead 8, Abbott 8, Western 0, Intuitive 0.
- Saved **23 captures** (one SEC, five robots, seventeen jobs) and **22 signals**.
  Every quote verified against its source capture. Quote verification does not establish correct
  employer attribution, as the two incorrectly labeled career-site signals demonstrate.
- Website confirmation made **59 HTTP requests**, plus five Hunter and four TinyFish calls.
  Actual paid Treg/LLM spend: **$0**; no LLM was used and paid fallback was disabled.
- Compared all company, review, and score rows with the test baseline: unchanged.
  Also verified all original rows/exported fields in the seven copied dashboard tables remained
  unchanged: 154 companies, 234 contacts, 623 scores, 139 insights, 271 weekly snapshots,
  one outreach-settings row, eight drafts.
- Disabled only the two newly created, incorrectly attributed local Workday site records and
  recorded their actual employers in `last_status`. Captures and signals remain for diagnosis.
  No company-wide rejection was created, and no existing review decision was changed.
- Production was not read or written. No deployment, schedule, policy change, or code change
  was made for this experiment. No regression suite was run; this was a live observational test.

Private harness, baseline, results, decision preview, audits, quarantine record and diagnostic
HTML are under ignored `var/five-workday-links-2026-10-25/`; the command log is
`var/five-workday-links-run.log`.

## Recommended next steps

1. Validate the employer behind a guessed tenant before labeling its evidence as the SEC company;
   explicitly detect conflicting employer identities. Keep these two mismatches as regression cases.
2. Fix corporate identity parsing for `Corporation` and prioritize independently source-backed
   search candidates without letting unrelated provider noise determine the result.
3. Distinguish inaccessible verification from missing evidence. Preserve an ordinary review/retry
   path for genuinely blocked sites.
4. Keep ownership checks. Evaluate strong alternative first-party evidence when no direct link is
   available, rather than accepting a corporate website and a similarly named tenant independently.
5. After those changes, recheck the preserved cases and demonstrate actual local admission and
   scoring on a verified company, followed by a duplicate-free repeat. Scheduling remains untested.
