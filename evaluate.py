import sys
import os
import json
import csv
import math

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from train_model import SYMPTOM_DICTIONARY, extract_text_features

def load_model(model_path="ai_model.json"):
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model artifact not found at: {model_path}. Run train_model.py first.")
    with open(model_path, "r", encoding="utf-8") as f:
        return json.load(f)

def predict_single(patient, model):
    feature_names = model["feature_names"]
    weights = model["weights"]
    bias = model["bias"]
    num_classes = model["num_classes"]
    
    complaint = str(patient.get("complaint", ""))
    text_feats = extract_text_features(complaint)
    
    feats = []
    for fname in feature_names:
        if fname.startswith("sym_"):
            feats.append(text_feats.get(fname, 0.0))
        elif fname == "spo2_low":
            spo2 = float(patient.get("spo2", 98))
            feats.append(1.0 if spo2 < 90 else (0.5 if spo2 < 94 else 0.0))
        elif fname == "sbp_low":
            sbp = float(patient.get("sbp", 120))
            feats.append(1.0 if sbp < 90 else 0.0)
        elif fname == "sbp_high":
            sbp = float(patient.get("sbp", 120))
            feats.append(1.0 if sbp > 180 else 0.0)
        elif fname == "hr_high":
            hr = float(patient.get("hr", 75))
            feats.append(1.0 if hr > 120 else (0.5 if hr > 100 else 0.0))
        elif fname == "hr_low":
            hr = float(patient.get("hr", 75))
            feats.append(1.0 if hr < 50 else 0.0)
        elif fname == "rr_high":
            rr = float(patient.get("rr", 16))
            feats.append(1.0 if rr > 24 else 0.0)
        elif fname == "temp_high":
            temp = float(patient.get("temp", 36.8))
            feats.append(1.0 if temp > 38.5 else 0.0)
        elif fname == "gcs_low":
            gcs = float(patient.get("gcs", 15))
            feats.append(1.0 if gcs <= 12 else 0.0)
        elif fname == "age_elderly":
            age = float(patient.get("age", 40))
            feats.append(1.0 if age >= 65 else 0.0)
        elif fname == "age_pediatric":
            age = float(patient.get("age", 40))
            feats.append(1.0 if age < 12 else 0.0)
        else:
            feats.append(0.0)

    logits = [bias[c] + sum(weights[c][j] * feats[j] for j in range(len(feats))) for c in range(num_classes)]
    max_l = max(logits)
    exp_l = [math.exp(l - max_l) for l in logits]
    sum_exp = sum(exp_l)
    probs = [e / sum_exp for e in exp_l]
    
    pred_class = max(range(num_classes), key=lambda c: logits[c]) + 1
    confidence = probs[pred_class - 1]
    
    return pred_class, confidence, probs

def simple_baseline_predict(patient):
    """Simple baseline heuristic without ML weights."""
    spo2 = float(patient.get("spo2", 98))
    gcs = float(patient.get("gcs", 15))
    sbp = float(patient.get("sbp", 120))
    complaint = str(patient.get("complaint", "")).lower()
    
    if spo2 < 90 or gcs <= 8 or sbp < 80 or "stroke" in complaint or "unconscious" in complaint:
        return 1
    if spo2 <= 93 or "chest pain" in complaint or "breath" in complaint or sbp > 190:
        return 2
    if "fever" in complaint or "abdominal" in complaint:
        return 3
    if "cut" in complaint or "sprain" in complaint or "rash" in complaint:
        return 4
    return 5

def evaluate(csv_path="data/benchmark_cohort_1000.csv", model_path="ai_model.json"):
    print(f"=== Medi Flow Triage Evaluation (Dataset: {csv_path}) ===")
    model = load_model(model_path)
    
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Evaluation dataset not found: {csv_path}")

    records = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            records.append(row)

    total_records = len(records)
    print(f"[+] Loaded {total_records:,} test records.")

    tp, fp, tn, fn = 0, 0, 0, 0
    correct_ai = 0
    b_tp, b_fp, b_tn, b_fn = 0, 0, 0, 0
    correct_baseline = 0

    matrix_5x5 = [[0] * 5 for _ in range(5)]

    for p in records:
        true_label = int(p["true_label"])
        # True emergency is Level 1 or critical presentation
        is_true_emergency = 1 if (true_label == 1 or (true_label == 2 and float(p.get("spo2", 98)) < 94)) else 0

        # AI Prediction
        ai_pred, ai_conf, _ = predict_single(p, model)
        if ai_pred == true_label:
            correct_ai += 1
            
        matrix_5x5[ai_pred - 1][true_label - 1] += 1
        ai_is_emergency = 1 if ai_pred in [1, 2] else 0

        if is_true_emergency == 1:
            if ai_is_emergency == 1:
                tp += 1
            else:
                fn += 1
        else:
            if ai_is_emergency == 1:
                fp += 1
            else:
                tn += 1

        # Baseline Prediction
        b_pred = simple_baseline_predict(p)
        if b_pred == true_label:
            correct_baseline += 1
        b_is_emergency = 1 if b_pred in [1, 2] else 0
        if is_true_emergency == 1:
            if b_is_emergency == 1:
                b_tp += 1
            else:
                b_fn += 1
        else:
            if b_is_emergency == 1:
                b_fp += 1
            else:
                b_tn += 1

    ai_recall = (tp / max(1, (tp + fn))) * 100.0
    ai_under_triage = (fn / max(1, (tp + fn))) * 100.0
    ai_over_triage = (fp / max(1, (tn + fp))) * 100.0
    ai_accuracy = (correct_ai / total_records) * 100.0

    b_recall = (b_tp / max(1, (b_tp + b_fn))) * 100.0
    b_under_triage = (b_fn / max(1, (b_tp + b_fn))) * 100.0
    b_accuracy = (correct_baseline / total_records) * 100.0

    print("\n" + "=" * 68)
    print(" 🏥 MEDI FLOW AI vs. BASELINE PERFORMANCE COMPARISON")
    print("=" * 68)
    print(f" {'Metric':<30} | {'Medi Flow AI':<16} | {'Simple Baseline':<16}")
    print("-" * 68)
    print(f" {'Emergency Recall (Sensitivity)':<30} | {ai_recall:>14.2f}% | {b_recall:>14.2f}%")
    print(f" {'Under-Triage Rate (RED)':<30} | {ai_under_triage:>14.2f}% | {b_under_triage:>14.2f}%")
    print(f" {'Missed Emergencies (FN)':<30} | {fn:>15} | {b_fn:>15}")
    print(f" {'Unnecessary Escalations (FP)':<30} | {fp:>15} | {b_fp:>15}")
    print(f" {'Exact 5-Level Accuracy':<30} | {ai_accuracy:>14.2f}% | {b_accuracy:>14.2f}%")
    print("=" * 68)

    print("\n[+] 5x5 Confusion Matrix (Predicted Acuity [Rows] vs True Acuity [Cols]):")
    print("       True L1   True L2   True L3   True L4   True L5    Total Pred")
    for r in range(5):
        row_str = f"Pred L{r+1}   " + "   ".join(f"{matrix_5x5[r][c]:>7}" for c in range(5)) + f"   {sum(matrix_5x5[r]):>9}"
        print(row_str)
    print("Total     " + "   ".join(f"{sum(matrix_5x5[r][c] for r in range(5)):>7}" for c in range(5)))
    print("=" * 68)

    # Export predictions to H1_predictions.csv
    out_csv_path = "H1_predictions.csv"
    with open(out_csv_path, "w", newline="", encoding="utf-8") as f_out:
        fieldnames = [
            "visit_id", "age", "sex", "complaint", "spo2", "sbp", "hr", "rr", "temp", "gcs",
            "true_label", "predicted_level", "confidence_pct", "recommended_dept", "emergency_status"
        ]
        writer = csv.DictWriter(f_out, fieldnames=fieldnames)
        writer.writeheader()
        for p in records:
            pred_class, conf, _ = predict_single(p, model)
            writer.writerow({
                "visit_id": p.get("visit_id", ""),
                "age": p.get("age", ""),
                "sex": p.get("sex", ""),
                "complaint": p.get("complaint", ""),
                "spo2": p.get("spo2", ""),
                "sbp": p.get("sbp", ""),
                "hr": p.get("hr", ""),
                "rr": p.get("rr", ""),
                "temp": p.get("temp", ""),
                "gcs": p.get("gcs", ""),
                "true_label": p.get("true_label", ""),
                "predicted_level": pred_class,
                "confidence_pct": round(conf * 100, 1),
                "recommended_dept": p.get("department", "General Medicine"),
                "emergency_status": "CRITICAL" if pred_class == 1 else ("EMERGENT" if pred_class == 2 else "ROUTINE")
            })
    print(f"\n[+] Competition predictions exported to {out_csv_path} ({len(records)} rows).")

    return {
        "total_records": total_records,
        "ai_recall": ai_recall,
        "ai_under_triage": ai_under_triage,
        "ai_over_triage": ai_over_triage,
        "ai_accuracy": ai_accuracy
    }

if __name__ == "__main__":
    csv_file = sys.argv[1] if len(sys.argv) > 1 else "data/benchmark_cohort_1000.csv"
    evaluate(csv_file)
