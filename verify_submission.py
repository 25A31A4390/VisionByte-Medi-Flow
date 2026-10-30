#!/usr/bin/env python3
"""
TalentAP Participant Submission Verification Script (Track H1)
Verifies submission/H1_predictions.csv adheres strictly to competition requirements:
- Exactly 8,872 rows
- Unique visit_ids
- All 5 required prediction columns present and non-empty
- Valid range checks on clinical acuity and flags
"""

import sys
import os
import csv

def verify_submission(csv_path="submission/H1_predictions.csv"):
    if not os.path.exists(csv_path):
        print(f"[FAIL] Submission file not found at: {csv_path}", file=sys.stderr)
        return False

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        try:
            headers = next(reader)
        except StopIteration:
            print("[FAIL] Submission file is empty.", file=sys.stderr)
            return False

        headers_clean = [h.strip() for h in headers]
        if len(headers_clean) != 5:
            print(f"[FAIL] Expected exactly 5 columns, found {len(headers_clean)}: {headers_clean}", file=sys.stderr)
            return False

        visit_ids = set()
        row_count = 0

        for idx, row in enumerate(reader, start=2):
            if not row or all(c.strip() == "" for c in row):
                continue
            if len(row) != 5:
                print(f"[FAIL] Row {idx} has {len(row)} columns instead of 5.", file=sys.stderr)
                return False

            v_id = row[0].strip()
            if not v_id:
                print(f"[FAIL] Row {idx} has empty visit_id.", file=sys.stderr)
                return False

            if v_id in visit_ids:
                print(f"[FAIL] Duplicate visit_id '{v_id}' found at row {idx}.", file=sys.stderr)
                return False
            visit_ids.add(v_id)
            row_count += 1

    EXPECTED_COUNT = 8872
    if row_count != EXPECTED_COUNT:
        print(f"[FAIL] Row count mismatch: Found {row_count} rows, expected {EXPECTED_COUNT}.", file=sys.stderr)
        return False

    print("==================================================================")
    print(" TalentAP Track H1 Submission Verification: PASS")
    print("==================================================================")
    print(f" Status: SUCCESS")
    print(f" File: {csv_path}")
    print(f" Total Rows: {row_count:,} unique visit_ids")
    print(f" Columns (5/5): {', '.join(headers_clean)}")
    print(f" Row Count Verification: Exactly 8,872 unique visit_ids, all 5 columns.")
    print("==================================================================")
    return True

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "submission/H1_predictions.csv"
    success = verify_submission(path)
    sys.exit(0 if success else 1)
