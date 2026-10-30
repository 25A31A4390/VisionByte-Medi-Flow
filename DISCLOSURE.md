# Medi Flow – Project Disclosure, Attribution & Presentation Plan

> **AI Frontier Challenge 2026 – Track H1: Healthcare & Clinical AI**  
> Comprehensive transparency disclosure detailing human domain guidance, AI coding assistance, privacy safeguards, and final presentation team ownership.

---

## 1. Transparency on Human vs. AI Contributions

In adherence to the ethical standards of the **AI Frontier Challenge 2026** and genuine healthcare technology integrity, here is the transparent attribution of contributions:

### Conceptualization, Clinical Architecture & Human Domain Guidance
- **Healthcare Philosophy:** Formulation of the foundational mandate: *Reliable Data Processing + Appropriate Human Oversight*. The system is strictly decision-support, never diagnoses, and ensures qualified clinician sign-off on every patient routing.
- **5-Level ESI Clinical Standards:** Translating Emergency Severity Index (ESI) triage criteria, age-band physiological thresholds (infant $<1$, child $1-12$, adult, elderly $\ge 65$), and emergency red-flag symptoms into deterministic clinical logic.
- **Asymmetric Emergency Recall Requirement:** Requiring the loss optimization to mathematically penalize under-triage 36× more severely than over-triage to ensure zero missed critical patients.
- **Safety Invariant Formulation:** Formulating the core medical invariants:
  1. Missing vitals *never* lowers triage urgency.
  2. Objective vital emergency rules *strictly override* lower-risk machine learning suggestions.
  3. Red-flag symptoms with unmeasured vitals trigger algorithmic *abstention* (*"Cannot assess safely – Send to nurse for immediate human review"*).
- **Indic Multilingual Design:** Curating clinical symptom vocabularies across English, Hindi (Devanagari), Telugu (Script), and transliterated vernacular expressions (Hinglish/Telugish) reflecting real Indian OPD patient presentations.
- **Two-Person Approval & Governance:** Designing the administrative security model requiring approval from a different administrator before Doctor or Admin accounts can activate.

### AI Coding Assistance & Implementation Acceleration
- **Vanilla JavaScript & DOM Architecture:** Accelerating the construction of the zero-dependency browser-native UI, flexbox layouts, SVG cut-out logo, and responsive CSS grids.
- **Client-Side Cryptography:** Implementing salted SHA-256 password hashing with per-user salt generation using the browser's native `window.crypto.subtle.digest` API.
- **Queueing Theory Simulator:** Generating the discrete-event multi-server queuing mathematical engine ($M/M/c$) for the What-If Hospital Operations Simulator.
- **Synthetic Cohort Generation:** Generating the 30,000-record synthetic training dataset and the 1,000-patient benchmark cohort matching competition specifications.
- **Automated Test Harnesses:** Writing headless browser automation scripts and unit test harnesses covering 28 clinical assertions.

---

## 2. Zero External Dependencies & Privacy Clarification

- **100% Offline Capability:** Medi Flow contains **zero npm packages**, **zero external CDN stylesheets/scripts**, and **zero backend servers**. It opens and functions completely via `file:///index.html` in an air-gapped browser.
- **100% Synthetic Healthcare Data:** All patient records, vital parameters, and case scenarios are entirely synthetic. No Protected Health Information (PHI) or real patient records were used at any stage.
- **Zero Network Transmission & Zero Telemetry:** The application executes exclusively inside the client's local browser memory and `localStorage`. No data, cookies, telemetry, or user audio inputs are transmitted to remote servers or third-party cloud APIs.

---

## 3. Simulated vs. Production Capabilities Matrix

| Architectural Dimension | Hackathon Prototype Implementation | Enterprise Clinical Production Requirements |
| :--- | :--- | :--- |
| **Authentication & SSO** | Browser-local Web Crypto SHA-256 with per-user salt & lockout timer. | Hospital Active Directory / LDAP, OAuth2 / OIDC, FIDO2 hardware tokens, and biometric SSO. |
| **License Verification** | Simulated administrative manual check checkbox. | Automated real-time API verification against National Medical Commission (NMC) registries. |
| **Data Persistence** | Browser `localStorage` (synthetic records only). | HIPAA/GDPR-compliant PostgreSQL cluster with AES-256 encryption at rest and TLS 1.3 transit encryption. |
| **EHR Interoperability** | Client-side CSV import/export and JSON rules sandbox. | HL7 FHIR (`Encounter`, `Observation`, `Flag`) and HL7 v2 (`ADT`) bidirectionally synchronized with Hospital Information Systems (HIS). |
| **Vitals Capture** | User interface inputs & voice dictation. | Direct biomedical device telemetry via MQTT/Bluetooth/Serial feeds from patient vital signs monitors. |
| **Speech Processing** | Browser Web Speech API (`SpeechRecognition`). | On-premise specialized medical Whisper / IndicConformer speech models tuned for clinical terminology. |

---

## 4. Hackathon Presentation Team Ownership Matrix

The 7-minute competition presentation and live judging demonstration is structured into four coordinated segments:

| Presentation Segment | Duration | Primary Speaker | Core Demonstration Topics |
| :--- | :---: | :---: | :--- |
| **1. The Problem & Clinical Mandate** | **1.5 min** | **Speaker 1** (Clinical Lead) | • OPD overcrowding & triage delays in Indian hospitals.<br>• Core principle: Decision support + Human oversight.<br>• The danger of black-box AI in acute triage. |
| **2. Multimodal AI & Indic NLP Architecture** | **1.5 min** | **Speaker 2** (AI/ML Engineer) | • Multilingual NLP (English, Hindi, Telugu, Transliterated).<br>• Asymmetric emergency loss weighting (36× penalty).<br>• 100% Emergency Recall benchmark performance vs. 90.3% baseline. |
| **3. Live System Demonstration & Hospital Simulator** | **2.5 min** | **Speaker 3** (Full-Stack Engineer) | • Live patient intake with Hands-Free Voice Dictation.<br>• Live Explainable AI (XAI) modal with factor breakdown.<br>• What-If Hospital Simulator: FCFS vs. Urgency Prioritization (50% wait reduction).<br>• Smart Emergency Alert chime & pulsing queue row. |
| **4. Safety Invariants & Governance Validation** | **1.5 min** | **Speaker 4** (Healthcare Architect) | • Verification of all 28 automated browser invariants (100% pass).<br>• Proof that mandatory safety rules override lower-risk ML.<br>• Failsafe guardrails and clinical abstention.<br>• Production HL7 FHIR scaling roadmap & Q&A. |
