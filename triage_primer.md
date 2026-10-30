# OPD Triage Primer: Chandrapuri District Hospital

> **Simplified for the hackathon, not for clinical use.** This primer adapts the Emergency Severity Index (ESI v4) and well-known early-warning thresholds to a crowded Indian government OPD registration desk. It is a teaching rubric for synthetic data. It is not a clinical guideline and must never be used to triage real patients.

**Ethics note.** All healthcare data is synthetic. No team may use real patient data. Every healthcare solution must be positioned as clinician-assisting, not clinician-replacing, and must include a safety/escalation path. Teams that present an autonomous diagnostic system without a human-in-the-loop will lose points on the Responsibility criterion.

## 1. How the labels in this dataset were made

Every visit has a hidden **true clinical state**: what is really going on, the patient's true vital signs, and which red-flag features are truly present. The labels (`triage_level`, `department`, `red_flags`, `true_emergency`) come from applying **exactly the rules in this primer** to that true state.

Your inputs show that state only partly:

- The complaint text may **under-state** the problem (a stoic farmer says "thoda sa"), **over-state** it ("bahut tez dard, emergency!" for a minor problem), or describe it atypically (an elderly diabetic having a heart attack may only say "ghabrahat, pet mein gas").
- The **recorded** vitals may be missing or mis-entered. The labels use the **true** vitals, not the recorded ones.

`true_emergency = 1` exactly when the level is 1 or 2.

## 2. The 5-level scale

| Level | Name | Meaning | Target time to doctor |
|---|---|---|---|
| **1** | Resuscitation | Needs an immediate life-saving intervention | Immediately |
| **2** | Emergent | High-risk situation: any red-flag symptom (Section 4, which includes new confusion/drowsiness) or any danger-zone vital sign | ≤ 10–15 min |
| **3** | Urgent | Stable, but needs **two or more** kinds of hospital resources, or has an amber vital sign | ≤ 30–60 min |
| **4** | Less urgent | Stable, needs **one** kind of resource | ≤ 2 h |
| **5** | Non-urgent | Stable, needs **no** resources (advice, oral medicine, prescription refill, routine check) | Routine queue |

## 3. The decision steps (apply in order and stop at the first that fits)

### Step A: Level 1 if ANY of these apply

| Level-1 sign | Description |
|---|---|
| Unresponsive | Unresponsive, or responds only to pain |
| Convulsing now | Still convulsing when brought in |
| Gasping / blue | Gasping, blue lips, not breathing adequately |
| Shock | Collapse with cold clammy skin and a weak fast pulse |
| Massive bleeding | Uncontrolled major bleeding |
| Severe allergic reaction | Throat closing, or collapse |
| Needs a life-saving drug now | Pesticide poisoning with frothing / heavy secretions (needs atropine), or a diabetic with low sugar who is confused/drowsy (needs IV glucose) |
| Very low oxygen | SpO2 < 85 % (any age), **or** SpO2 < 90 % together with severe respiratory distress |
| Severe hypotension (shock) | Systolic BP < 80 mmHg at age ≥ 10 years; in a child < 10 years, systolic BP below the PALS hypotension limit: < 60 (under 1 month), < 70 (1–12 months), < 70 + 2 × age in years (1 to < 10 years) |
| Slow heart in a child | Heart rate < 60 /min in a child under 8 years |

### Step B: Level 2 if ANY red flag (Section 4) OR ANY danger-zone vital sign

**Danger-zone vital signs** (true values; age in completed years unless stated):

| Vital | Rule |
|---|---|
| SpO2 | < 92 % (any age) |
| Temperature | ≤ 35.0 °C (any age) |
| Heart rate, age < 3 months | > 180 /min |
| Heart rate, age 3 months to < 3 years | > 160 /min |
| Heart rate, age 3 to < 8 years | > 140 /min |
| Heart rate, age 8 to < 16 years | > 120 /min or ≤ 40 /min (ESI v5 school-age band, extended to 15 y; more sensitive than the adult cut-off. Fever raises the heart rate, but still escalate) |
| Heart rate, age ≥ 16 years | ≥ 131 /min or ≤ 40 /min (NEWS2) |
| Systolic BP, age ≥ 10 years | ≤ 90 mmHg |
| Systolic BP, age ≥ 16 years | ≥ 220 mmHg |
| Pregnant (`pregnant = Y`) | systolic ≥ 160 or diastolic ≥ 110 mmHg |
| Infant < 3 months | temperature ≥ 38.0 °C (this also sets the red flag `RF_HIGH_FEVER_INFANT`), or temperature < 36.0 °C |

Respiratory rate is not recorded at this registration desk. Breathing problems reach you through the complaint text ("pasli chal rahi hai", "saans phool rahi hai") and SpO2. The pregnancy BP rules apply to `pregnant = Y`. For women who delivered recently, use the eclampsia red flag.

### Step C: Level 3 if the patient needs ≥ 2 resources OR has ANY amber vital sign

**Amber vital signs** (true values):

| Vital | Rule |
|---|---|
| SpO2 | 92–93 % |
| Temperature | ≥ 39.1 °C (age 3 months or older) |
| Heart rate, age ≥ 16 years | 111–130 /min |
| Pregnant (`pregnant = Y`) | systolic 140–159 or diastolic 90–109 mmHg |

### Step D: otherwise Level 4 (one resource) or Level 5 (no resources)

Infants younger than 3 months are never Level 5. This is an exception to resource counting: a minor illness at this age is at least Level 4, because the infant always needs a doctor's review.

**What counts as a resource** (count *kinds*, not tests: three blood tests are one resource):

| Counts as a resource | Does NOT count |
|---|---|
| Laboratory tests (blood, urine, sputum) | History and examination |
| ECG | Bedside sugar or other point-of-care tests |
| X-ray | Oral medicines, ORS at home, prescriptions and refills |
| Ultrasound / CT / MRI | |
| IV fluids | Tetanus injection |
| IV / IM / nebulised medicines (including rabies vaccine and immunoglobulin) | Simple dressing, sling, crutches |
| Simple procedure (suturing, draining a boil, removing a foreign body or ear wax, nasal packing, urinary catheter, infiltrating rabies immunoglobulin into a bite wound) = 1 | Referral to an OPD department (in this OPD version, seeing a department is not counted) |
| Complex procedure (reduction of a fracture under sedation) = 2 | Routine scheduled screening tests at check-ups |
| Supervised oral rehydration in the hospital ORS corner (WHO Plan B) | |

## 4. Red-flag codes

Any red flag makes the patient **at least Level 2**. Report every red flag you detect in `red_flags`, separated by `;`. The same list is in `data/red_flag_codes.csv`.

| Code | Present when |
|---|---|
| RF_CHEST_PAIN_CARDIAC | Chest pain/pressure/heaviness/tightness that may be cardiac (not pain clearly caused by an injury, cough or meals), OR new cardiac-equivalent symptoms today in a diabetic/elderly patient (sudden uneasiness 'ghabrahat' with sweating, breathlessness or epigastric 'gas' discomfort) |
| RF_STROKE_SIGNS | Sudden face droop, one-sided arm/leg weakness, or slurred/absent speech (FAST) |
| RF_RESP_DISTRESS | Severe breathing difficulty: cannot speak full sentences, struggling to breathe, chest indrawing in a sick child, choking on a foreign body |
| RF_ALTERED_SENSORIUM | New confusion, drowsiness (including sleepiness after a fit), not recognising family, unresponsive |
| RF_SEIZURE | Fits/convulsions now or within the last few hours |
| RF_SEVERE_BLEEDING | Vomiting blood, black tarry stools, coughing up large amounts of blood (a wound bleeding that will not stop is uncontrolled major bleeding = Level 1) |
| RF_PREGNANCY_BLEEDING | Vaginal bleeding in pregnancy, or heavy bleeding after delivery |
| RF_ECLAMPSIA_SIGNS | Pregnant (>20 weeks) or recently delivered with severe headache, blurred vision, upper-abdominal pain, face/hand swelling, or fits |
| RF_REDUCED_FETAL_MOVEMENT | Third-trimester pregnancy with reduced or absent baby movements |
| RF_POISONING | Swallowed pesticide/insecticide, rat poison, kerosene or an overdose of tablets, or pesticide exposure while spraying with symptoms |
| RF_SNAKEBITE | Any snakebite (even without symptoms yet) |
| RF_SCORPION_STING | Scorpion sting with sweating, vomiting, cold limbs or breathlessness, or any sting in a child |
| RF_SEVERE_DEHYDRATION | Diarrhoea/vomiting with signs of severe dehydration: lethargic, sunken eyes, unable to drink, very slow skin pinch, fainting, very little urine |
| RF_HIGH_FEVER_INFANT | Infant younger than 3 months with temperature >= 38.0 C |
| RF_CHILD_DANGER_SIGNS | Child under 5 years who is unable to drink/breastfeed, vomiting everything, lethargic/unconscious, or has had convulsions (WHO IMCI general danger signs) |
| RF_SEPSIS_SIGNS | Fever with cold limbs/cold clammy skin or very little urine (any age); fever with confusion in a patient aged 15+ (without neck stiffness); or ANY fever in a patient on cancer chemotherapy |
| RF_MENINGITIS_SIGNS | Fever with neck stiffness (any age), or fever with confusion/unresponsiveness in a child under 15 (meningitis/encephalitis/AES). A fit with fever in a child 6 months-5 years who is only sleepy afterwards is a febrile seizure (RF_SEIZURE), not this flag |
| RF_DENGUE_WARNING | Suspected dengue: an acute fever (2-7 days) with NO other obvious source (no loose motions, no burning urine, no vaginal discharge, no pain localised to the right lower or lower/pelvic abdomen, no jaundice) PLUS a warning sign: abdominal pain, persistent vomiting (vomiting everything), bleeding gums/nose, black stools, lethargy/restlessness, or giddiness (cold clammy skin with collapse = shock = Level 1) |
| RF_SUICIDAL | Thoughts of self-harm or suicide, or a self-harm attempt (including a poisoning where the complaint mentions intent, e.g. after a quarrel / 'does not want to live') |
| RF_ACUTE_PSYCHOSIS_AGITATION | Acutely agitated/violent behaviour, danger to others |
| RF_TRAUMA_MAJOR | High-risk injury: high-energy road accident (hit by truck/bus, thrown off a vehicle, injuries at many places, cannot get up) or any road accident with a head injury or bleeding that will not stop; fall from height (roof, tree, first floor); head injury with blackout/vomiting/confusion. A simple slip or fall with one swollen/bent limb is a suspected fracture (Level 3), not this flag |
| RF_ANAPHYLAXIS | Allergic reaction with lip/tongue/face swelling or breathing difficulty (throat closing or collapse = Level 1) |
| RF_DKA_SIGNS | Diabetic with very high sugar plus vomiting, abdominal pain, deep fast breathing or drowsiness |
| RF_HYPOGLYCAEMIA | Diabetic on insulin/sugar tablets with sweating, shaking, odd behaviour or confusion |
| RF_HEAT_STROKE | Very hot body after heat exposure with confusion or collapse (heat stroke, not counted as sepsis/meningitis; Level 2 for new confusion unless a Level-1 sign or vital is present) |
| RF_ACUTE_ABDOMEN | Severe abdominal pain with hard/distended belly, no stool or gas, stuck painful hernia, or (in a woman with a missed period) severe one-sided pain |
| RF_THUNDERCLAP_HEADACHE | Sudden, severe 'worst-ever' headache |
| RF_TESTICULAR_TORSION | Sudden severe testicular pain |
| RF_EYE_EMERGENCY | Chemical/lime splash into the eye or sudden loss of vision |
| RF_BURNS_MAJOR | Large burns, burns of face/chest, or burns with breathing problems |

The same symptom can be harmless or a red flag depending on context. Bleeding gums while brushing, with no fever, is a dental problem; bleeding gums on day 4 of a fever is a dengue warning sign. "Gas" in a 30-year-old after spicy food is gastritis; "gas" with sweating and uneasiness in a 70-year-old diabetic may be a heart attack.

## 5. Departments

- **Every Level 1 and Level 2 patient goes to `Emergency/Casualty`**, whatever the complaint.
- For Level 3–5, use the department for the complaint (table below and `data/departments.csv`).
- **Children under 12 years** with medical complaints (fever, cough/cold, breathing, diarrhoea/vomiting, jaundice, worms, constipation) go to **Paediatrics**. Eye, ear/nose/throat, teeth, skin, injury and surgical problems go to that specialty department at any age.

| Department | Typical Level 3–5 complaints |
|---|---|
| General Medicine | fever without warning signs (suspected viral/dengue/malaria/typhoid/chikungunya/leptospirosis), cold and cough, acute chest infection/pneumonia, gastritis/acidity, loose motions (including some dehydration in adults), jaundice, urine burning (not pregnant), anaemia/weakness, diabetes and BP problems, headache, thyroid, refills, follow-up, certificates |
| Paediatrics | children < 12 with medical complaints, including diarrhoea with some dehydration, chest infections, wheeze; all infants < 3 months with minor illness |
| Obstetrics & Gynaecology | pregnancy check-ups and pregnancy problems (vomiting, mildly raised BP, urine burning in pregnancy), discharge, period problems, pelvic infection, contraception, infertility |
| General Surgery | wounds, boils, cellulitis, diabetic foot, dog bites, appendicitis-type pain, kidney-stone pain, gall-bladder pain, urine retention, hernia, piles, breast lump |
| Orthopaedics | back/neck/shoulder/knee pain, sprains, suspected fractures, chest-wall injury |
| ENT | ear pain/discharge, blocked ear needing wax removal, sore throat/tonsils as the main complaint, nose bleeds, foreign body in ear/nose |
| Ophthalmology | glasses/refractive error, cataract, red eye ("eye flu"), foreign body in eye |
| Dermatology | scabies/itching, ringworm, eczema, acne, white patches, hives without breathing trouble, numb skin patch |
| Psychiatry | anxiety, sleep problems, low mood, mild alcohol withdrawal |
| Dental | toothache, gum bleeding while brushing, dental swelling, wisdom tooth |
| Cardiology | stable exertional breathlessness with leg swelling, recurrent palpitations that have settled |
| Pulmonology/Chest & TB | cough > 2 weeks / suspected TB, TB on treatment, asthma or COPD (age 12+), inhaler refills |

## 6. Typical levels (examples, not an exhaustive list)

| Level | Typical examples in this OPD |
|---|---|
| 1 | Unresponsive after pesticide ingestion, or pesticide with frothing at the mouth; convulsing now; snakebite with drooping eyelids, blue lips and SpO2 80 %; heart attack with BP 70 and cold sweat; bleeding pregnant woman in shock; diabetic with low sugar who is confused |
| 2 | Chest pain (or the diabetic "ghabrahat + sweating + gas" equivalent); stroke signs; any snakebite; pesticide ingestion; dengue warning signs; severe dehydration; fever in a baby under 3 months; bleeding in pregnancy; severe headache/blurred vision in late pregnancy; suicidal thoughts; heart rate 150 with palpitations; SpO2 89 % with pneumonia; BP 230/120 |
| 3 | Suspected appendicitis, kidney-stone pain, suspected fracture, pneumonia with normal oxygen, TB work-up (sputum + X-ray), adult diarrhoea with some dehydration needing IV fluids, deep dog bite (category III: wound care + immunoglobulin + vaccine), jaundice, fever ≥ 39.1 °C, adult heart rate 111–130 |
| 4 | Fever needing blood tests (dengue/malaria/typhoid), urine infection (urine test), sprain needing an X-ray, cut needing stitches, boil needing drainage, dog scratch (vaccine), mild asthma needing one nebulisation, child with some dehydration (supervised ORS) |
| 5 | Common cold, acidity, chronic back/knee pain, scabies, ringworm, glasses, cataract review, toothache, routine pregnancy check-up, prescription refill, certificate |

## 7. When you cannot assess

A case **cannot be assessed** (`assessable = 0` in the labels) when the complaint gives no usable clinical information (blank, "-", "?", "doctor ko dikhana hai", language not understood) **and** at most one vital sign is usable. A usable vital is present and physically possible: BP pair 20–260 mmHg, pulse 25–250, temperature 30–45 °C (or 86–113 °F, which can be converted), SpO2 50–100 %.

For such cases the right answer is `ABSTAIN` ("cannot assess, send to nurse now"). Abstaining on an assessable, non-emergency patient costs nurse time (see the README for the scoring).

## 8. Your mandatory escalation rule layer

Your system must include hard-coded rules, shown in your demo, that override the model whenever the **recorded** vitals are critical (for example SpO2 < 92, adult pulse ≥ 131 or ≤ 40, systolic ≤ 90, a febrile infant under 3 months). Recorded vitals can be mis-entered. A rule layer must first decide whether a value is believable: temperature 101.3 in a °C column is almost certainly °F; BP 0/0 means "not measured"; SpO2 999 is a typo. When in doubt, escalate.

## 9. Sources (concepts and thresholds adapted from)

1. Gilboy N, et al. *Emergency Severity Index (ESI) Version 4 Implementation Handbook*, AHRQ/ENA 2012: Level-1/Level-2 definitions, danger-zone vital signs (incl. paediatric heart-rate bands), paediatric fever rules, resource definitions. <https://www.govinfo.gov/content/pkg/GOVPUB-HE20_6500-PURL-gpo23161/pdf/GOVPUB-HE20_6500-PURL-gpo23161.pdf> (paediatric heart-rate bands under 8 years from v4; for 8–15 years this primer uses the ESI v5 (2023) school-age band HR > 120: <https://media.emscimprovement.center/documents/Emergency_Severity_Index_Handbook.pdf>).
2. Royal College of Physicians. *National Early Warning Score 2 (NEWS2)*, 2017: single-parameter red (score 3) and amber (score 2) thresholds for adults. <https://gloshospitals.nhs.uk/media/documents/NEWS_2_CHART.pdf>
3. American Heart Association. *PALS*: age-based hypotension limits and bradycardia algorithm. <https://cpr.heart.org/-/media/CPR-Files/CPR-Guidelines-Files/2025-Algorithms/Algorithm-PALS-Bradycardia-250121.pdf>
4. NICE NG143. *Fever in under 5s*, traffic-light table (temperature ≥ 38 °C under 3 months = red). <https://www.nice.org.uk/guidance/ng143>
5. WHO. *Integrated Management of Childhood Illness*, general danger signs; *Pocket Book of Hospital Care for Children*, 2nd ed., emergency signs and dehydration plans. <https://www.afro.who.int/sites/default/files/2017-06/module_1_0.pdf>
6. National Center for Vector Borne Diseases Control (MoHFW). *National Guidelines for Clinical Management of Dengue*, 2023: warning signs; dengue season July–November with post-monsoon peak. <https://ncvbdc.mohfw.gov.in/Doc/National%20Guidelines%20for%20Clinical%20Management%20of%20Dengue%20Fever%202023.pdf>
7. MoHFW. *Standard Treatment Guidelines: Snakebite*, 2016: snakebite as a time-critical emergency. <https://clinicalestablishments.mohfw.gov.in/sites/default/files/standard-treatment-guidelines/3941.pdf>
8. Sahu AK, et al. *AIIMS Triage Protocol (ATP)*, J Emerg Trauma Shock 2020: Indian emergency-department triage practice. <https://www.indusem.org/wp-content/uploads/covid/ATP-AIIMS.pdf>
9. ACOG Practice Bulletin 222: severe-range blood pressure in pregnancy (≥ 160/110). <https://www.aafp.org/pubs/afp/issues/2019/1115/p649.html>
10. NCDC/MoHFW. *National Guidelines on Rabies Prophylaxis*: category III bites. <https://clinicalestablishments.mohfw.gov.in/sites/default/files/standard-treatment-guidelines/238.pdf>
11. NCDC/NPCCHH. *Emergency Cooling for Severe Heat-Related Illnesses*, 2024: heat stroke = temperature ≥ 40 °C with CNS dysfunction.
12. World Allergy Organization. *Anaphylaxis Guidance*, 2020.
13. 2021 AHA/ACC Chest Pain Guideline: anginal equivalents (breathlessness, fatigue, nausea, epigastric discomfort).

*Simplified for the TalentAP Mega Hackathon 2026. Not for clinical use.*
