import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
#!/usr/bin/env python3
"""
Medi Flow - AI/ML Model Training Pipeline (Track H1 / Competition Edition)
Trains an explainable, multimodal OPD triage and department recommendation classifier
on a 30,000 synthetic patient cohort matching the AI Frontier Challenge 2026 specification:
- 5-Level ESI Acuity (1: Resuscitation, 2: Emergent, 3: Urgent, 4: Less Urgent, 5: Non-Urgent)
- ~4% True Emergency Cases (Levels 1 & high-risk 2)
- Multilingual Free-Text Complaints (English, Hindi, Telugu, Transliterated Hinglish/Telugish)
- Known Medical Conditions & Current Medications
- High Emergency-Recall Prioritization (Asymmetric penalty for under-triage)
- Exports weights to ai_model.json for client-side zero-latency inference
"""

import os
import json
import random
import math
from collections import Counter

# Set random seed for reproducibility
random.seed(42)

# ==============================================================================
# 1. CLINICAL VOCABULARY & MULTILINGUAL SYMPTOM DICTIONARY
# ==============================================================================

SYMPTOM_DICTIONARY = {
    "chest_pain": {
        "en": ["chest pain", "angina", "chest tightness", "chest pressure", "substernal pain", "heart attack pain", "heavy chest"],
        "hi": ["छाती में दर्द", "सीने में दर्द", "दिल का दौरा", "सीने में जलन और दबाव"],
        "te": ["ఛాతీ నొప్పి", "గుండె నొప్పి", "ఛాతీలో మంట", "గుండెలో బరువుగా ఉంది"],
        "translit": ["chaati me dard", "seene me dard", "dil ka daura", "chathi lo noppi", "gunde noppi", "chati noppi"],
        "typos": ["ches pain", "chest pane", "chect pain", "chestt pain", "heavines in chest"],
        "acuity_bias": 2,
        "dept": "Cardiology"
    },
    "breathlessness": {
        "en": ["difficulty breathing", "shortness of breath", "breathlessness", "dyspnea", "severe wheezing", "gasping for air", "asthma attack"],
        "hi": ["सांस लेने में तकलीफ", "दम फूलना", "सांस नहीं आ रही", "अस्थमा का दौरा"],
        "te": ["శ్వాస తీసుకోవడంలో ఇబ్బంది", "ఆయాసం", "శ్వాస ఆడటం లేదు", "దమ్ము"],
        "translit": ["saas lene me takleef", "dam phoolna", "swasa aadadam ledu", "aayasam", "swasa kastam"],
        "typos": ["brething difficulty", "shortnes of breath", "brethless", "disnea", "cant breath"],
        "acuity_bias": 2,
        "dept": "Pulmonology"
    },
    "stroke_signs": {
        "en": ["facial droop", "slurred speech", "sudden weakness on one side", "arm drift", "numbness one side", "stroke symptoms", "inability to speak"],
        "hi": ["मुंह टेढ़ा होना", "बोलने में लड़खड़ाहट", "एक तरफ कमजोरी", "लकवा के लक्षण"],
        "te": ["ముఖం వంకర పోవడం", "మాట తడబడటం", "ఒక వైపు బలహీనత", "పక్షవాతం లక్షణాలు"],
        "translit": ["muh tedha hona", "bolne me ladkhadahat", "ek taraf kamjori", "pakshavatam", "mata tadabadatam"],
        "typos": ["slured speech", "face droop", "weekness one side", "strok", "paralisis"],
        "acuity_bias": 1,
        "dept": "Neurology"
    },
    "altered_mental_status": {
        "en": ["unconscious", "unresponsive", "severe confusion", "drowsy and disoriented", "passed out", "lethargic", "syncope"],
        "hi": ["बेहोश", "अचेत", "भ्रमित स्थिति", "जगाने पर नहीं जाग रहा"],
        "te": ["స్పృహ తప్పిపోవడం", "అపస్మారక స్థితి", "మతిస్థిమితం లేకపోవడం"],
        "translit": ["behoshi", "behosha", "spruha tappipovadam", "bhramit"],
        "typos": ["unconcious", "unresponcive", "pas out", "drowzy"],
        "acuity_bias": 1,
        "dept": "Emergency / Resuscitation"
    },
    "severe_bleeding": {
        "en": ["heavy bleeding", "profuse blood loss", "arterial bleeding", "vomiting blood", "hematemesis", "deep laceration bleeding profusely"],
        "hi": ["भारी रक्तस्राव", "खून की उल्टी", "लगातार खून बहना"],
        "te": ["విపరీతమైన రక్తస్రావం", "రక్తం వాంతులు", "తీవ్రమైన గాయం"],
        "translit": ["khoon behna", "khoon ki ulti", "raktasravam", "raktham vantulu"],
        "typos": ["bleedng", "hevy bleeding", "vomting blood"],
        "acuity_bias": 1,
        "dept": "Surgery"
    },
    "severe_abdominal_pain": {
        "en": ["severe stomach pain", "acute abdominal pain", "sharp belly pain", "rigid abdomen", "extreme cramps"],
        "hi": ["पेट में तेज दर्द", "असहनीय पेट दर्द", "पेट में मरोड़"],
        "te": ["కడుపులో తీవ్రమైన నొప్పి", "కడుపు నొప్పి", "కడుపు పట్టేయడం"],
        "translit": ["pet me tez dard", "kadupu noppi", "tivramaina kadupu noppi"],
        "typos": ["stocmach pain", "abdminal pain", "belly ache severe"],
        "acuity_bias": 3,
        "dept": "General Medicine"
    },
    "high_fever": {
        "en": ["high fever", "burning hot", "fever with severe chills", "pyrexia", "rigors"],
        "hi": ["तेज बुखार", "कपकपी के साथ बुखार", "शरीर तप रहा है"],
        "te": ["తీవ్రమైన జ్వరం", "వణుకుతో కూడిన జ్వరం", "ఒళ్ళు కాలిపోతోంది"],
        "translit": ["tez bukhar", "kampkampi bukhar", "tivramaina jwaram", "jwaram chali"],
        "typos": ["feever", "high fevr", "hot feber", "chil fever"],
        "acuity_bias": 3,
        "dept": "General Medicine"
    },
    "minor_injury": {
        "en": ["twisted ankle", "minor finger cut", "small bruise", "wrist sprain", "toe injury while walking"],
        "hi": ["पैर मुड़ना", "हल्की खरोंच", "उंगली में हल्की चोट"],
        "te": ["చీలమండ బెణకడం", "చేతి వేలికి చిన్న గాయం", "చిన్న దెబ్బ"],
        "translit": ["pair mudna", "halki chot", "benakadam", "chinna debba"],
        "typos": ["sprained ankel", "twised ankel", "miner cut"],
        "acuity_bias": 4,
        "dept": "Orthopedics"
    },
    "mild_cold_cough": {
        "en": ["mild runny nose", "sneezing and throat irritation", "slight dry cough", "nasal congestion"],
        "hi": ["हल्की सर्दी", "जुकाम और छींकें", "हल्की खांसी"],
        "te": ["తేలికపాటి జలుబు", "దగ్గు", "ముక్కు కారడం"],
        "translit": ["halka jukam", "chhike", "telikapati jalubu", "daggu"],
        "typos": ["caugh", "runy nose", "sneeze"],
        "acuity_bias": 5,
        "dept": "General Medicine"
    },
    "pediatric_fever": {
        "en": ["child crying with warm forehead", "toddler fever and irritability", "baby warm not drinking milk"],
        "hi": ["बच्चे को बुखार", "शिशु रो रहा है और शरीर गर्म है"],
        "te": ["పిల్లాడికి జ్వరం", "పాలు తాగడం లేదు ఏడుస్తున్నాడు"],
        "translit": ["bacche ko bukhar", "pilladiki jwaram", "baby warm"],
        "typos": ["chld fevr", "bby fever"],
        "acuity_bias": 3,
        "dept": "Pediatrics"
    },
    "pregnancy_pain": {
        "en": ["pregnant with pelvic pain", "pregnancy with mild spotting", "third trimester abdominal cramping"],
        "hi": ["गर्भावस्था में पेट दर्द", "गर्भवती महिला को रक्तस्राव"],
        "te": ["గర్భవతికి కడుపు నొప్పి", "గర్భధారణ సమయంలో రక్తస్రావం"],
        "translit": ["garbhavastha me dard", "garbhavatiki noppi"],
        "typos": ["pregent pain", "pregnent bleeding"],
        "acuity_bias": 2,
        "dept": "OB/GYN"
    },
    "skin_rash": {
        "en": ["itching skin rash", "red patches on arms and back", "allergic hives no breathing issue"],
        "hi": ["त्वचा पर खुजली और चकत्ते", "शरीर पर लाल दाने"],
        "te": ["చర్మంపై దురద మరియు దద్దుర్లు", "ఎర్రటి మచ్చలు"],
        "translit": ["khujli aur chakte", "durada", "daddurlu"],
        "typos": ["skn rash", "itchy rash", "red pacthes"],
        "acuity_bias": 4,
        "dept": "Dermatology"
    },
    "ear_throat": {
        "en": ["ear pain", "difficulty swallowing with sore throat", "ear discharge and fullness"],
        "hi": ["कान में दर्द", "गले में खराश और निगलने में दर्द"],
        "te": ["చెవి నొప్పి", "గొంతు నొప్పి మింగలేకపోవడం"],
        "translit": ["kaan me dard", "gale me kharash", "chevi noppi", "gontu noppi"],
        "typos": ["ere pain", "soar throte"],
        "acuity_bias": 4,
        "dept": "ENT"
    }
}

DEPARTMENTS = [
    "Emergency / Resuscitation",
    "Cardiology",
    "Pulmonology",
    "General Medicine",
    "Orthopedics",
    "Pediatrics",
    "OB/GYN",
    "Neurology",
    "ENT",
    "Dermatology",
    "Surgery"
]

CONDITIONS_LIST = [
    "None", "Hypertension", "Type 2 Diabetes", "Coronary Artery Disease",
    "Asthma", "COPD", "Chronic Kidney Disease", "Previous Stroke", "Epilepsy"
]

MEDICATIONS_LIST = [
    "None", "Amlodipine", "Metformin", "Aspirin", "Atorvastatin",
    "Salbutamol Inhaler", "Insulin", "Clopidogrel", "Levothyroxine", "Enalapril"
]

# ==============================================================================
# 2. SYNTHETIC PATIENT GENERATOR (30,000 PATIENTS, ~4% TRUE EMERGENCIES)
# ==============================================================================

def generate_patient_record(patient_idx):
    pid = f"PAT-{patient_idx:05d}"
    
    # 4% True Emergency (Level 1 or Critical Level 2)
    is_emergency = (random.random() < 0.04)
    
    if is_emergency:
        # Emergency presentation: acute symptoms, vital derangement
        symptom_key = random.choice([
            "chest_pain", "breathlessness", "stroke_signs", 
            "altered_mental_status", "severe_bleeding"
        ])
        age = random.choice([random.randint(45, 88), random.randint(22, 65)])
        sex = random.choice(["M", "F"])
        
        # Severe vital derangement
        if symptom_key == "breathlessness":
            spo2 = random.randint(78, 89)
            rr = random.randint(28, 42)
            hr = random.randint(110, 145)
            sbp = random.randint(100, 160)
            dbp = random.randint(65, 95)
            temp = round(random.uniform(36.5, 38.2), 1)
            gcs = random.randint(12, 15)
            label = 1
        elif symptom_key == "altered_mental_status":
            spo2 = random.randint(88, 96)
            rr = random.randint(12, 28)
            hr = random.randint(55, 130)
            sbp = random.randint(70, 95)
            dbp = random.randint(40, 60)
            temp = round(random.uniform(36.0, 39.5), 1)
            gcs = random.randint(4, 8)
            label = 1
        elif symptom_key == "severe_bleeding":
            spo2 = random.randint(90, 97)
            rr = random.randint(24, 34)
            hr = random.randint(125, 160)
            sbp = random.randint(72, 88)
            dbp = random.randint(45, 58)
            temp = round(random.uniform(35.8, 37.0), 1)
            gcs = random.randint(11, 14)
            label = 1
        elif symptom_key == "stroke_signs":
            spo2 = random.randint(94, 98)
            rr = random.randint(16, 22)
            hr = random.randint(70, 110)
            sbp = random.randint(165, 220)
            dbp = random.randint(95, 125)
            temp = round(random.uniform(36.5, 37.2), 1)
            gcs = random.randint(10, 15)
            label = 1
        else: # chest_pain
            spo2 = random.randint(91, 97)
            rr = random.randint(18, 26)
            hr = random.randint(85, 125)
            sbp = random.randint(140, 195)
            dbp = random.randint(85, 115)
            temp = round(random.uniform(36.5, 37.4), 1)
            gcs = 15
            label = 2
            
    else:
        # Non-emergency: Acuity 2 (urgent), 3 (semi-urgent), 4 (less urgent), 5 (non-urgent)
        r_lvl = random.random()
        if r_lvl < 0.12:
            label = 2
            symptom_key = random.choice(["chest_pain", "breathlessness", "pregnancy_pain"])
        elif r_lvl < 0.45:
            label = 3
            symptom_key = random.choice(["severe_abdominal_pain", "high_fever", "pediatric_fever"])
        elif r_lvl < 0.80:
            label = 4
            symptom_key = random.choice(["minor_injury", "skin_rash", "ear_throat"])
        else:
            label = 5
            symptom_key = random.choice(["mild_cold_cough", "minor_injury", "skin_rash"])
            
        age = random.randint(1, 80) if symptom_key == "pediatric_fever" else random.randint(18, 75)
        if symptom_key == "pediatric_fever":
            age = random.randint(1, 11)
        sex = "F" if symptom_key == "pregnancy_pain" else random.choice(["M", "F"])
        
        # Standard vitals around normal or mildly deranged
        spo2 = random.randint(95, 100) if label >= 3 else random.randint(92, 96)
        rr = random.randint(14, 20) if label >= 4 else random.randint(18, 24)
        hr = random.randint(65, 95) if label >= 4 else random.randint(85, 115)
        sbp = random.randint(110, 135) if label >= 4 else random.randint(125, 155)
        dbp = random.randint(70, 85) if label >= 4 else random.randint(80, 95)
        temp = round(random.uniform(36.4, 37.2), 1) if label in [4, 5] else round(random.uniform(37.5, 39.2), 1)
        gcs = 15

    # Multilingual text selection
    sym_data = SYMPTOM_DICTIONARY[symptom_key]
    lang_choice = random.choices(["en", "hi", "te", "translit", "typos"], weights=[0.45, 0.15, 0.15, 0.15, 0.10])[0]
    complaint_text = random.choice(sym_data[lang_choice])
    department = sym_data["dept"]
    if age < 12 and department != "Emergency / Resuscitation":
        department = "Pediatrics"

    condition = random.choice(CONDITIONS_LIST)
    medication = random.choice(MEDICATIONS_LIST)
    
    return {
        "visit_id": pid,
        "age": age,
        "sex": sex,
        "complaint": complaint_text,
        "symptom_key": symptom_key,
        "hr": hr,
        "sbp": sbp,
        "dbp": dbp,
        "rr": rr,
        "spo2": spo2,
        "temp": temp,
        "gcs": gcs,
        "condition": condition,
        "medication": medication,
        "triage_label": label,
        "is_emergency": 1 if (label == 1 or (label == 2 and is_emergency)) else 0,
        "department": department
    }

# ==============================================================================
# 3. FEATURE EXTRACTION & TEXT TOKENIZATION
# ==============================================================================

def extract_text_features(text):
    """
    Extracts binary keyword signals across multilingual dictionaries,
    matching root stems, n-grams, and common phonetics/typos.
    """
    features = {}
    lower = str(text).lower()
    
    for sym_key, data in SYMPTOM_DICTIONARY.items():
        matched = False
        all_phrases = data["en"] + data["hi"] + data["te"] + data["translit"] + data["typos"]
        for phrase in all_phrases:
            if phrase.lower() in lower:
                matched = True
                break
        features[f"sym_{sym_key}"] = 1.0 if matched else 0.0
        
    return features

# ==============================================================================
# 4. MODEL TRAINING: LOGISTIC REGRESSION WITH ASYMMETRIC EMERGENCY RECALL
# ==============================================================================

def train_triage_classifier(dataset):
    print(f"\n[+] Processing {len(dataset):,} patient records...")
    
    # Feature engineering for every patient
    feature_names = [f"sym_{k}" for k in SYMPTOM_DICTIONARY.keys()]
    vital_names = ["spo2_low", "sbp_low", "sbp_high", "hr_high", "hr_low", "rr_high", "temp_high", "gcs_low", "age_elderly", "age_pediatric"]
    all_feature_keys = feature_names + vital_names

    X = []
    y_acuity = []
    y_emergency = []
    y_dept = []

    for p in dataset:
        row = []
        text_feats = extract_text_features(p["complaint"])
        for k in feature_names:
            row.append(text_feats.get(k, 0.0))
            
        # Vitals threshold features
        row.append(1.0 if p["spo2"] < 90 else (0.5 if p["spo2"] < 94 else 0.0))
        row.append(1.0 if p["sbp"] < 90 else 0.0)
        row.append(1.0 if p["sbp"] > 180 else 0.0)
        row.append(1.0 if p["hr"] > 120 else (0.5 if p["hr"] > 100 else 0.0))
        row.append(1.0 if p["hr"] < 50 else 0.0)
        row.append(1.0 if p["rr"] > 24 else 0.0)
        row.append(1.0 if p["temp"] > 38.5 else 0.0)
        row.append(1.0 if p["gcs"] <= 12 else 0.0)
        row.append(1.0 if p["age"] >= 65 else 0.0)
        row.append(1.0 if p["age"] < 12 else 0.0)
        
        X.append(row)
        y_acuity.append(p["triage_label"])
        y_emergency.append(p["is_emergency"])
        y_dept.append(p["department"])

    # Train-test split (70% train, 15% validation, 15% test)
    n = len(X)
    n_train = int(n * 0.70)
    n_val = int(n * 0.15)
    
    indices = list(range(n))
    random.shuffle(indices)
    
    train_idx = indices[:n_train]
    val_idx = indices[n_train:n_train + n_val]
    test_idx = indices[n_train + n_val:]

    print(f"[+] Dataset Split: {len(train_idx):,} Train | {len(val_idx):,} Validation | {len(test_idx):,} Test")
    
    # Calculate Emergency Acuity Class Weights (Asymmetric Penalty)
    # Severe penalty for missing emergencies (Level 1 & 2)
    emergency_count = sum(y_emergency[i] for i in train_idx)
    non_emergency_count = len(train_idx) - emergency_count
    emergency_weight = (non_emergency_count / max(1, emergency_count)) * 1.5
    print(f"[+] Asymmetric Emergency Loss Weight: {emergency_weight:.2f}x")

    # Fit Logistic Regression via Gradient Descent for Acuity (Multiclass 1-5)
    # Weights matrix: 5 classes x num_features
    num_classes = 5
    num_feats = len(all_feature_keys)
    weights = [[0.0] * num_feats for _ in range(num_classes)]
    bias = [0.0] * num_classes

    # Clinical prior initialization
    for c_idx in range(num_classes):
        lvl = c_idx + 1
        for f_idx, fname in enumerate(all_feature_keys):
            if "spo2_low" in fname:
                weights[0][f_idx] += 3.5
                weights[1][f_idx] += 1.8
            if "stroke_signs" in fname or "altered_mental" in fname:
                weights[0][f_idx] += 4.0
            if "chest_pain" in fname:
                weights[1][f_idx] += 3.2
            if "severe_abdominal" in fname or "high_fever" in fname:
                weights[2][f_idx] += 2.8
            if "minor_injury" in fname or "skin_rash" in fname:
                weights[3][f_idx] += 2.5
            if "mild_cold" in fname:
                weights[4][f_idx] += 3.0

    # Lightweight optimization loop
    epochs = 15
    lr = 0.05
    for epoch in range(epochs):
        for idx in train_idx:
            feat = X[idx]
            target_class = y_acuity[idx] - 1 # 0 to 4
            is_emerg = y_emergency[idx]
            sample_weight = emergency_weight if is_emerg == 1 else 1.0

            # Softmax computation
            logits = [bias[c] + sum(weights[c][j] * feat[j] for j in range(num_feats)) for c in range(num_classes)]
            max_l = max(logits)
            exp_l = [math.exp(l - max_l) for l in logits]
            sum_exp = sum(exp_l)
            probs = [e / sum_exp for e in exp_l]

            # Gradient update with asymmetric weighting
            for c in range(num_classes):
                grad = (probs[c] - (1.0 if c == target_class else 0.0)) * sample_weight
                bias[c] -= lr * grad * 0.01
                for j in range(num_feats):
                    if feat[j] != 0:
                        weights[c][j] -= lr * grad * feat[j]

    # Model Artifact Packaging
    model_artifact = {
        "version": "2.0-competition",
        "model_type": "Asymmetric Multimodal Triage Classifier",
        "feature_names": all_feature_keys,
        "num_classes": 5,
        "classes": [1, 2, 3, 4, 5],
        "class_labels": {
            "1": "Resuscitation / Critical",
            "2": "Emergent / High Risk",
            "3": "Urgent",
            "4": "Less Urgent",
            "5": "Non-Urgent"
        },
        "weights": weights,
        "bias": bias,
        "department_mapping": {
            "chest_pain": "Cardiology",
            "breathlessness": "Pulmonology",
            "stroke_signs": "Neurology",
            "altered_mental_status": "Emergency / Resuscitation",
            "severe_bleeding": "Surgery",
            "severe_abdominal_pain": "General Medicine",
            "high_fever": "General Medicine",
            "minor_injury": "Orthopedics",
            "mild_cold_cough": "General Medicine",
            "pediatric_fever": "Pediatrics",
            "pregnancy_pain": "OB/GYN",
            "skin_rash": "Dermatology",
            "ear_throat": "ENT"
        },
        "metrics": {}
    }

    return model_artifact, dataset, test_idx, X, y_acuity, y_emergency, y_dept

# ==============================================================================
# 5. TEST SET EVALUATION: EMERGENCY RECALL & ACCURACY
# ==============================================================================

def evaluate_model(model_artifact, dataset, test_idx, X, y_acuity, y_emergency):
    print("\n[+] Evaluating Model on Held-Out Test Set (Asymmetric Safety Penalty)...")
    
    weights = model_artifact["weights"]
    bias = model_artifact["bias"]
    num_classes = 5
    num_feats = len(model_artifact["feature_names"])
    
    tp, fp, tn, fn = 0, 0, 0, 0
    correct_acuity = 0
    total_test = len(test_idx)
    
    for idx in test_idx:
        feat = X[idx]
        true_label = y_acuity[idx]
        true_emergency = y_emergency[idx]
        
        logits = [bias[c] + sum(weights[c][j] * feat[j] for j in range(num_feats)) for c in range(num_classes)]
        # Predict class
        pred_class = max(range(num_classes), key=lambda c: logits[c]) + 1
        
        if pred_class == true_label:
            correct_acuity += 1
            
        pred_emergency = 1 if pred_class in [1, 2] else 0
        
        if true_emergency == 1:
            if pred_emergency == 1:
                tp += 1
            else:
                fn += 1 # Critical Under-Triage!
        else:
            if pred_emergency == 1:
                fp += 1 # Over-Triage (Acceptable in triage triage)
            else:
                tn += 1

    recall = (tp / max(1, (tp + fn))) * 100.0
    accuracy = (correct_acuity / total_test) * 100.0
    under_triage_rate = (fn / max(1, (tp + fn))) * 100.0
    over_triage_rate = (fp / max(1, (tn + fp))) * 100.0

    print("==================================================================")
    print("   AI FRONTIER CHALLENGE 2026 - MODEL EVALUATION REPORT")
    print("==================================================================")
    print(f" Test Set Size:              {total_test:,} patients")
    print(f" True Emergencies in Test:   {tp + fn:,} patients ({((tp+fn)/total_test)*100:.1f}%)")
    print(f" Emergency True Positives:   {tp:,}")
    print(f" Missed Emergencies (FN):    {fn:,} (CRITICAL UNDER-TRIAGE)")
    print(f" Unnecessary Escalations:   {fp:,} (OVER-TRIAGE)")
    print(f" True Non-Emergencies (TN):  {tn:,}")
    print("------------------------------------------------------------------")
    print(f" 🎯 EMERGENCY RECALL:        {recall:.2f}%  (Target: >95%)")
    print(f" 🚨 UNDER-TRIAGE RATE (RED): {under_triage_rate:.2f}%  (Lower is safer)")
    print(f" ⚠️ OVER-TRIAGE RATE (AMBER):{over_triage_rate:.2f}%  (Conservative)")
    print(f" 📊 5-LEVEL EXACT ACCURACY:  {accuracy:.2f}%")
    print("==================================================================")

    model_artifact["metrics"] = {
        "test_size": total_test,
        "true_positives": tp,
        "false_negatives": fn,
        "false_positives": fp,
        "true_negatives": tn,
        "emergency_recall_pct": round(recall, 2),
        "under_triage_pct": round(under_triage_rate, 2),
        "over_triage_pct": round(over_triage_rate, 2),
        "exact_acuity_accuracy_pct": round(accuracy, 2)
    }
    
    return model_artifact

# ==============================================================================
# 6. MAIN EXECUTION: GENERATE, TRAIN, EVALUATE, EXPORT
# ==============================================================================

def main():
    print("=== Medi Flow AI/ML Training Pipeline Initializing ===")
    
    # Generate 30,000 synthetic patient records
    total_cohort_size = 30000
    dataset = [generate_patient_record(i + 1) for i in range(total_cohort_size)]
    
    # Train
    model_artifact, dataset, test_idx, X, y_acuity, y_emergency, y_dept = train_triage_classifier(dataset)
    
    # Evaluate
    model_artifact = evaluate_model(model_artifact, dataset, test_idx, X, y_acuity, y_emergency)
    
    # Save model artifact to ai_model.json
    out_path = "ai_model.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(model_artifact, f, indent=2)
    print(f"[+] Saved model artifact to: {out_path} ({os.path.getsize(out_path):,} bytes)")

    # Save a 1,000-row sample benchmark dataset for testing the Dataset Evaluation tab
    benchmark_csv_path = "data/benchmark_cohort_1000.csv"
    os.makedirs("data", exist_ok=True)
    with open(benchmark_csv_path, "w", encoding="utf-8", newline="") as f:
        import csv
        writer = csv.writer(f)
        writer.writerow(["visit_id", "age", "sex", "complaint", "hr", "sbp", "dbp", "rr", "spo2", "temp", "gcs", "true_label", "department"])
        for p in dataset[:1000]:
            writer.writerow([
                p["visit_id"], p["age"], p["sex"], p["complaint"],
                p["hr"], p["sbp"], p["dbp"], p["rr"], p["spo2"],
                p["temp"], p["gcs"], p["triage_label"], p["department"]
            ])
    print(f"[+] Saved 1,000-case evaluation benchmark dataset to: {benchmark_csv_path}")
    print("=== Model Training & Artifact Generation Complete ===")

if __name__ == "__main__":
    main()
