"""
Unit and Integration Test Suite for Medi Flow - Competition Track H1
Tests AI model artifacts, multilingual NLP extraction, benchmark evaluation, and clinical safety invariants.
"""

import os
import json
import csv
import unittest
import numpy as np

from train_model import SYMPTOM_DICTIONARY, extract_text_features
from evaluate import load_model, predict_single

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(BASE_DIR, "ai_model.json")
BENCHMARK_CSV = os.path.join(BASE_DIR, "data", "benchmark_cohort_1000.csv")

class TestMediFlowAI(unittest.TestCase):

    def setUp(self):
        self.assertTrue(os.path.exists(MODEL_PATH), f"Model file not found at {MODEL_PATH}")
        self.model = load_model(MODEL_PATH)
        self.weights = np.array(self.model["weights"])
        self.bias = np.array(self.model["bias"])
        self.feature_names = self.model["feature_names"]

    def test_model_artifact_integrity(self):
        """Verify ai_model.json contains valid weights, bias, feature names, and 5 classes."""
        self.assertEqual(self.model["num_classes"], 5)
        self.assertEqual(len(self.model["classes"]), 5)
        self.assertEqual(self.weights.shape, (5, len(self.feature_names)))
        self.assertEqual(len(self.bias), 5)
        self.assertIn("sym_chest_pain", self.feature_names)
        self.assertIn("spo2_low", self.feature_names)

    def test_benchmark_cohort_csv_integrity(self):
        """Verify benchmark cohort CSV contains 1,000 synthetic patient records."""
        self.assertTrue(os.path.exists(BENCHMARK_CSV), f"Benchmark CSV not found at {BENCHMARK_CSV}")
        with open(BENCHMARK_CSV, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        self.assertEqual(len(rows), 1000, f"Expected 1,000 benchmark records, got {len(rows)}")
        self.assertIn("true_label", rows[0])
        self.assertIn("complaint", rows[0])
        self.assertIn("spo2", rows[0])

    def test_multilingual_nlp_extraction(self):
        """Verify complaint text in English, Hindi, and Telugu extracts correct symptom features."""
        # English
        feats_en = extract_text_features("Severe crushing chest pain radiating to left arm")
        self.assertEqual(feats_en.get("sym_chest_pain"), 1.0)

        # Hindi (Devanagari)
        feats_hi = extract_text_features("छाती में दर्द और सांस लेने में तकलीफ")
        self.assertEqual(feats_hi.get("sym_chest_pain"), 1.0)

        # Telugu (Script)
        feats_te = extract_text_features("గుండె నొప్పి మరియు ఆయాసం")
        self.assertEqual(feats_te.get("sym_chest_pain"), 1.0)

        # Transliterated Hinglish
        feats_tr = extract_text_features("chaati me dard aur saans lene me takleef")
        self.assertEqual(feats_tr.get("sym_chest_pain"), 1.0)

    def test_emergency_recall_benchmark(self):
        """Verify Medi Flow AI model achieves >= 95% Emergency Recall on the benchmark cohort."""
        with open(BENCHMARK_CSV, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            records = list(reader)

        true_emergencies = [r for r in records if int(r["true_label"]) in (1, 2)]
        caught_emergencies = 0
        under_triaged_emergencies = 0

        for r in records:
            true_lvl = int(r["true_label"])
            patient = {
                "age": r["age"],
                "complaint": r["complaint"],
                "spo2": r["spo2"],
                "sbp": r["sbp"],
                "dbp": r["dbp"],
                "hr": r["hr"],
                "rr": r["rr"],
                "temp": r["temp"],
                "gcs": r["gcs"]
            }
            pred_lvl, conf, _ = predict_single(patient, self.model)
            if true_lvl in (1, 2):
                if pred_lvl in (1, 2):
                    caught_emergencies += 1
                elif pred_lvl > true_lvl:
                    under_triaged_emergencies += 1

        recall = (caught_emergencies / len(true_emergencies)) * 100
        under_triage_rate = (under_triaged_emergencies / len(true_emergencies)) * 100

        self.assertGreaterEqual(recall, 95.0, f"Emergency recall {recall:.2f}% is below 95% threshold")
        self.assertLessEqual(under_triage_rate, 5.0, f"Emergency under-triage rate {under_triage_rate:.2f}% exceeds 5% threshold")

    def test_deterministic_clinical_safety_invariants(self):
        """Verify that mandatory clinical safety rules override and protect against critical hypoxia."""
        # Patient presenting with mild cold complaint but severe hypoxia SpO2 = 88%
        hypoxic_patient = {
            "age": "45",
            "complaint": "mild cold runny nose",
            "spo2": "88",
            "sbp": "120",
            "hr": "75",
            "rr": "16",
            "temp": "36.8",
            "gcs": "15"
        }

        pred_lvl, conf, _ = predict_single(hypoxic_patient, self.model)
        self.assertEqual(pred_lvl, 1, f"Hypoxic patient (SpO2 88%) was classified as {pred_lvl}, expected Level 1")

if __name__ == "__main__":
    unittest.main()
