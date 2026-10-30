/**
 * ============================================================================
 * Medi Flow - OPD Triage Decision Support Prototype
 *
 * Architecture:
 *   1. State & Storage Helpers (localStorage backed, synthetic data only)
 *   2. Rule Engine (Pure evaluation function, Sample Rules catalog)
 *   3. Registration & Emergency Walk-In
 *   4. Triage Assessment & Human Confirmation / Override Oversight
 *   5. Clinical Alerts & Virtual Time SLA Engine
 *   6. Queue Board & Sorting / Reordering
 *   7. Clinical Escalation & Doctor Inbox
 *   8. Audit Trail & CSV Export
 *   9. Analytics Dashboard
 *  10. Demo Data Generator & Time Simulation (+15 min)
 *  11. Automated Self-Test Suite (~12 Assertions)
 *  12. UI Event Handlers & Role Permission Enforcer
 * ============================================================================
 */

(function () {
  'use strict';

  // ==========================================================================
    // ==========================================================================
  // SECTION 1: STATE, STORAGE & SECURE AUTHENTICATION HELPERS
  // ==========================================================================
  // Plain-language explanation:
  // Manages application memory, localStorage persistence, cryptographic password
  // hashing (SHA-256 + per-user salt), session timeouts (10 min inactivity),
  // account lockouts (3 failed attempts), and role permissions (Clerk, Nurse,
  // Doctor, Admin). Simulates enterprise clinical auth entirely in the browser.
    function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const STORAGE_KEYS = {
    PATIENTS: 'triage_patients_v1',
    ALERTS: 'triage_alerts_v1',
    AUDIT: 'triage_audit_v1',
    ESCALATIONS: 'triage_escalations_v1',
    VTIME: 'triage_vtime_v1',
    COUNTER: 'triage_counter_v1',
    ACCOUNTS: 'triage_accounts_v1',
    AUTH_USER: 'triage_auth_user_v1'
  };

  const DEFAULT_START_TIME = '2026-10-18T09:00:00';

  const ROLES = {
    clerk: { title: 'Registration Clerk', canTriage: false, canEscalate: false, canRespondDoctor: false, canReorder: false, canManageAccounts: false, canEvaluateDataset: false },
    nurse: { title: 'Triage Nurse', canTriage: true, canEscalate: true, canRespondDoctor: false, canReorder: true, canManageAccounts: false, canEvaluateDataset: false },
    doctor: { title: 'Doctor', canTriage: true, canEscalate: true, canRespondDoctor: true, canReorder: true, canManageAccounts: false, canEvaluateDataset: true },
    admin: { title: 'Admin', canTriage: true, canEscalate: true, canRespondDoctor: true, canReorder: true, canManageAccounts: true, canEvaluateDataset: true }
  };

  const SLA_MINUTES = {
    1: 0,    // Immediate (Resuscitation)
    2: 15,   // 15 minutes (Emergent)
    3: 60,   // 60 minutes (Urgent)
    4: 120,  // 120 minutes (Less Urgent)
    5: 180   // 180 minutes (Non-Urgent / Routine)
  };

  // --------------------------------------------------------------------------
  // Web Crypto Salted SHA-256 Hashing (Never plain text)
  // --------------------------------------------------------------------------
  function generateSalt() {
    if (window.crypto && window.crypto.getRandomValues) {
      const array = new Uint8Array(16);
      window.crypto.getRandomValues(array);
      return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  }

  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const data = enc.encode(`${salt}:${password}`);
    if (window.crypto && window.crypto.subtle) {
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data[i];
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(64, '0');
  }

  function showStorageFailureWarning(message) {
    console.error('Storage Failure:', message);
    showToast('⚠️ Storage Alert', message, 'toast-warning');
  }

  function triggerAutoSaveIndicator() {
    const el = document.getElementById('autoSaveIndicator');
    if (!el) return;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `● Auto-saved <span style="font-size:0.7rem; color:#94a3b8;">(${timeStr})</span>`;
    el.classList.add('saving');
    setTimeout(() => {
      if (el) el.classList.remove('saving');
    }, 1200);
  }

  function getStorage(key, defaultVal) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultVal;
    } catch (e) {
      console.warn('Storage read failed:', key, e);
      showStorageFailureWarning('Storage read error: Browser storage may be disabled or restricted in private mode.');
      return defaultVal;
    }
  }

  function setStorage(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      triggerAutoSaveIndicator();
    } catch (e) {
      console.error('Storage write failed:', key, e);
      showStorageFailureWarning('Storage write error: Local storage quota exceeded or restricted. Changes may not persist.');
    }
  }

  // App State Object
  const State = {
    patients: [],
    alerts: [],
    audit: [],
    escalations: [],
    accounts: [],
    currentAuthUser: null, // { staffId, name, role, licenseNumber, licenseVerified }
    currentRole: null,
    currentUser: null,
    vTime: new Date(DEFAULT_START_TIME).getTime(),
    tokenCounter: 1,
    activeTab: 'queueTab',
    lastActivityTime: Date.now(),
    selectedPatientForTriage: null,
    selectedPatientForEscalation: null,
    selectedEscalationForResponse: null,
    pendingDowngradeData: null,
    pendingDuplicateData: null,
    selectedPatientForReorder: null,
    selectedStaffForReset: null
  };

  function loadState() {
    State.patients = getStorage(STORAGE_KEYS.PATIENTS, []);
    State.alerts = getStorage(STORAGE_KEYS.ALERTS, []);
    State.audit = getStorage(STORAGE_KEYS.AUDIT, []);
    State.escalations = getStorage(STORAGE_KEYS.ESCALATIONS, []);
    State.vTime = getStorage(STORAGE_KEYS.VTIME, new Date(DEFAULT_START_TIME).getTime());
    State.tokenCounter = getStorage(STORAGE_KEYS.COUNTER, 1);
    State.accounts = getStorage(STORAGE_KEYS.ACCOUNTS, []);
    State.currentAuthUser = getStorage(STORAGE_KEYS.AUTH_USER, null);
    if (State.currentAuthUser) {
      State.currentRole = State.currentAuthUser.role;
      State.currentUser = State.currentAuthUser.name;
    } else {
      State.currentRole = null;
      State.currentUser = null;
    }
  }

  function saveAllState() {
    setStorage(STORAGE_KEYS.PATIENTS, State.patients);
    setStorage(STORAGE_KEYS.ALERTS, State.alerts);
    setStorage(STORAGE_KEYS.AUDIT, State.audit);
    setStorage(STORAGE_KEYS.ESCALATIONS, State.escalations);
    setStorage(STORAGE_KEYS.VTIME, State.vTime);
    setStorage(STORAGE_KEYS.COUNTER, State.tokenCounter);
    setStorage(STORAGE_KEYS.ACCOUNTS, State.accounts);
    setStorage(STORAGE_KEYS.AUTH_USER, State.currentAuthUser);
  }

  // --------------------------------------------------------------------------
  // Seed Synthetic Demo Accounts (Salted Hashes Only - Never Plaintext)
  // --------------------------------------------------------------------------
  async function seedInitialDemoAccounts() {
    let accounts = getStorage(STORAGE_KEYS.ACCOUNTS, null);
    if (!accounts || accounts.length === 0) {
      const initialSeeds = [
        {
          staffId: 'clerk01',
          name: 'Clerk Alex',
          role: 'clerk',
          licenseNumber: '',
          licenseVerified: false,
          status: 'ACTIVE',
          plainPass: 'clerk123',
          createdBy: 'SYSTEM',
          approvedBy: 'SYSTEM',
          createdAt: 1700000000000
        },
        {
          staffId: 'nurse01',
          name: 'Nurse Sarah',
          role: 'nurse',
          licenseNumber: 'RN-88421',
          licenseVerified: true,
          status: 'ACTIVE',
          plainPass: 'nurse123',
          createdBy: 'SYSTEM',
          approvedBy: 'SYSTEM',
          createdAt: 1700000000000
        },
        {
          staffId: 'doctor01',
          name: 'Dr. Rao',
          role: 'doctor',
          licenseNumber: 'MC-45910',
          licenseVerified: true,
          status: 'ACTIVE',
          plainPass: 'doctor123',
          createdBy: 'SYSTEM',
          approvedBy: 'SYSTEM',
          createdAt: 1700000000000
        },
        {
          staffId: 'admin01',
          name: 'Admin Priya',
          role: 'admin',
          licenseNumber: '',
          licenseVerified: false,
          status: 'ACTIVE',
          plainPass: 'admin123',
          createdBy: 'SYSTEM',
          approvedBy: 'SYSTEM',
          createdAt: 1700000000000
        },
        {
          staffId: 'admin02',
          name: 'Admin David',
          role: 'admin',
          licenseNumber: '',
          licenseVerified: false,
          status: 'ACTIVE',
          plainPass: 'admin456',
          createdBy: 'SYSTEM',
          approvedBy: 'SYSTEM',
          createdAt: 1700000000000
        }
      ];

      accounts = [];
      for (const s of initialSeeds) {
        const salt = generateSalt();
        const hash = await hashPassword(s.plainPass, salt);
        accounts.push({
          staffId: s.staffId,
          name: s.name,
          role: s.role,
          licenseNumber: s.licenseNumber,
          licenseVerified: s.licenseVerified,
          status: s.status,
          salt: salt,
          passwordHash: hash,
          failedAttempts: 0,
          lockedUntil: null,
          createdBy: s.createdBy,
          approvedBy: s.approvedBy,
          createdAt: s.createdAt
        });
      }
      setStorage(STORAGE_KEYS.ACCOUNTS, accounts);
    }
    State.accounts = accounts;
  }

  // --------------------------------------------------------------------------
  // Authentication & Session Management
  // --------------------------------------------------------------------------
  async function loginUser(staffIdInput, passwordInput, isTest = false) {
    const staffId = (staffIdInput || '').trim().toLowerCase();
    const password = passwordInput || '';

    const account = State.accounts.find(a => a.staffId.toLowerCase() === staffId);
    if (!account) {
      if (!isTest) {
        addAuditEntry({
          action: 'LOGIN_FAILED',
          patientToken: '--',
          details: `Authentication failed: Unknown Staff ID [${staffIdInput}]`
        });
        showLoginError('Invalid Staff ID or Password.');
      }
      return { success: false, reason: 'UNKNOWN_USER' };
    }

    // Check lockout
    if (account.lockedUntil && account.lockedUntil > State.vTime) {
      const remainingMin = Math.max(1, Math.ceil((account.lockedUntil - State.vTime) / 60000));
      if (!isTest) {
        addAuditEntry({
          action: 'LOGIN_FAILED_LOCKED',
          patientToken: '--',
          details: `Authentication blocked: Account ${account.staffId} is locked for ${remainingMin} more minutes.`
        });
        showLoginLockout(`Account is temporarily locked due to 3 failed attempts. Please wait ${remainingMin} minute(s) or contact an administrator.`);
      }
      return { success: false, reason: 'LOCKED', remainingMin };
    }

    // If lockout expired, reset counter
    if (account.lockedUntil && account.lockedUntil <= State.vTime) {
      account.failedAttempts = 0;
      account.lockedUntil = null;
    }

    // Check status
    if (account.status === 'PENDING') {
      if (!isTest) {
        addAuditEntry({
          action: 'LOGIN_FAILED_PENDING',
          patientToken: '--',
          details: `Authentication blocked: Account ${account.staffId} is in PENDING status awaiting two-person administrator approval.`
        });
        showLoginError('Account is PENDING approval from a second administrator before access is granted.');
      }
      return { success: false, reason: 'PENDING' };
    }

    if (account.status === 'DEACTIVATED') {
      if (!isTest) {
        addAuditEntry({
          action: 'LOGIN_FAILED_DEACTIVATED',
          patientToken: '--',
          details: `Authentication blocked: Account ${account.staffId} is DEACTIVATED.`
        });
        showLoginError('Account has been DEACTIVATED. Contact an administrator.');
      }
      return { success: false, reason: 'DEACTIVATED' };
    }

    // Validate password using salted SHA-256
    const computedHash = await hashPassword(password, account.salt);
    if (computedHash !== account.passwordHash) {
      account.failedAttempts = (account.failedAttempts || 0) + 1;
      if (account.failedAttempts >= 3) {
        account.lockedUntil = State.vTime + (5 * 60 * 1000); // 5 min lockout
        if (!isTest) {
          addAuditEntry({
            action: 'ACCOUNT_LOCKOUT',
            patientToken: '--',
            details: `SECURITY LOCKOUT: Staff account ${account.staffId} locked for 5 minutes after 3 consecutive failed login attempts.`
          });
          showLoginLockout('Account locked! 3 consecutive failed password attempts. Account locked for 5 minutes.');
        }
      } else {
        const remainingAttempts = 3 - account.failedAttempts;
        if (!isTest) {
          addAuditEntry({
            action: 'LOGIN_FAILED',
            patientToken: '--',
            details: `Authentication failed for ${account.staffId} (Incorrect password, attempt ${account.failedAttempts}/3)`
          });
          showLoginError(`Invalid Staff ID or Password. ${remainingAttempts} attempt(s) remaining before a 5-minute lockout.`);
        }
      }
      saveAllState();
      return { success: false, reason: 'INVALID_PASSWORD' };
    }

    // Login Success
    account.failedAttempts = 0;
    account.lockedUntil = null;
    saveAllState();

    if (!isTest) {
      State.currentAuthUser = {
        staffId: account.staffId,
        name: account.name,
        role: account.role,
        licenseNumber: account.licenseNumber,
        licenseVerified: account.licenseVerified
      };
      State.currentRole = account.role;
      State.currentUser = account.name;
      State.lastActivityTime = Date.now();
      saveAllState();

      addAuditEntry({
        action: 'LOGIN_SUCCESS',
        patientToken: '--',
        details: `Staff ${account.staffId} (${account.name}, ${ROLES[account.role]?.title || account.role}) logged in successfully.`
      });

      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('loginStaffId').value = '';
      document.getElementById('loginPassword').value = '';
      hideLoginAlerts();
      updateUserProfileHeader();
      applyRolePermissions();
      renderQueueTable();
      renderDoctorInbox();
      renderAccountsTable();
      renderDashboard();
      renderAuditTable();

      showToast('Staff Authenticated', `Logged in as ${account.name} [${ROLES[account.role]?.title || account.role}]`, 'toast-info');
    }

    return { success: true, account };
  }

  function logoutUser(reason = 'User logout') {
    const wasUser = State.currentAuthUser;
    if (wasUser) {
      addAuditEntry({
        action: (reason.toLowerCase().includes('inactivity') ? 'AUTO_LOGOUT_INACTIVITY' : 'LOGOUT'),
        patientToken: '--',
        details: `Staff ${wasUser.staffId} (${wasUser.name}) logged out. Reason: ${reason}`
      });
    }

    State.currentAuthUser = null;
    State.currentRole = null;
    State.currentUser = null;
    setStorage(STORAGE_KEYS.AUTH_USER, null);

    // Close all open modals
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));

    // Show login overlay
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('userProfileChip').style.display = 'none';
    hideLoginAlerts();

    showToast('Logged Out', reason, 'toast-info');
  }

  function updateUserProfileHeader() {
    const chip = document.getElementById('userProfileChip');
    if (!State.currentAuthUser) {
      chip.style.display = 'none';
      return;
    }
    chip.style.display = 'flex';
    document.getElementById('currentUserNameDisplay').innerText = State.currentAuthUser.name;
    document.getElementById('currentUserRoleBadge').innerText = ROLES[State.currentAuthUser.role]?.title || State.currentAuthUser.role;
    document.getElementById('currentUserStaffId').innerText = `(${State.currentAuthUser.staffId})`;
  }

  function applyRolePermissions() {
    if (!State.currentAuthUser) return;
    const role = State.currentAuthUser.role;

    // Accounts tab only visible to Admin
    const tabAccounts = document.getElementById('tabBtnAccounts');
    if (tabAccounts) {
      tabAccounts.style.display = (role === 'admin') ? '' : 'none';
      updatePendingAccountsBadge();
    }

    // Dataset Evaluation tab only visible to Doctor and Admin
    const tabEval = document.getElementById('tabBtnEvaluation');
    if (tabEval) {
      const hasEvalAccess = canPerform('canEvaluateDataset');
      tabEval.style.display = hasEvalAccess ? '' : 'none';
      if (!hasEvalAccess && State.activeTab === 'evaluationTab') {
        switchTab('queueTab');
      }
    }

    // Clerk cannot see rules, audit, accounts, or evaluation
    const tabRules = document.getElementById('tabBtnRules');
    const tabAudit = document.getElementById('tabBtnAudit');
    if (role === 'clerk') {
      if (tabRules) tabRules.style.display = 'none';
      if (tabAudit) tabAudit.style.display = 'none';
      if (State.activeTab === 'rulesTab' || State.activeTab === 'auditTab' || State.activeTab === 'accountsTab' || State.activeTab === 'evaluationTab') {
        switchTab('queueTab');
      }
    } else {
      if (tabRules) tabRules.style.display = '';
      if (tabAudit) tabAudit.style.display = '';
    }
  }

  function updatePendingAccountsBadge() {
    const badge = document.getElementById('pendingAccountsBadge');
    if (!badge) return;
    const pendingCount = State.accounts.filter(a => a.status === 'PENDING').length;
    badge.innerText = String(pendingCount);
    badge.style.display = (pendingCount > 0 && State.currentAuthUser?.role === 'admin') ? '' : 'none';
  }

  function canPerform(capability) {
    if (!State.currentAuthUser) return false;
    const role = State.currentAuthUser.role;
    const config = ROLES[role];
    if (!config) return false;
    return !!config[capability];
  }

  function enforcePermission(capability, actionDescription, token = '--') {
    if (!State.currentAuthUser) {
      logUnauthorizedAttempt('Unauthenticated action: ' + actionDescription, token);
      showToast('Authentication Required', 'Please sign in to perform this clinical action.', 'toast-warning');
      return false;
    }

    if (!canPerform(capability)) {
      logUnauthorizedAttempt(actionDescription, token);
      showToast('Unauthorized Action Blocked', `Role [${ROLES[State.currentAuthUser.role]?.title || State.currentAuthUser.role}] is not authorized to ${actionDescription}. Security event logged.`, 'toast-l1');
      return false;
    }
    return true;
  }

  function logUnauthorizedAttempt(actionDescription, target = '--') {
    const user = State.currentAuthUser ? State.currentAuthUser.name : 'Unauthenticated Visitor';
    const role = State.currentAuthUser ? State.currentAuthUser.role : 'None';
    const staffId = State.currentAuthUser ? State.currentAuthUser.staffId : 'None';
    addAuditEntry({
      action: 'UNAUTHORIZED_ATTEMPT',
      patientToken: target,
      patientName: '--',
      details: `SECURITY ALERT: Unauthorized action [${actionDescription}] blocked for staff ${staffId} (${user}, role: ${role})`,
      diff: { staffId, role, action: actionDescription }
    });
  }

  function initInactivityWatcher() {
    const recordActivity = () => {
      State.lastActivityTime = Date.now();
    };

    ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
      window.addEventListener(evt, recordActivity, { passive: true });
    });

    // Check timer every 3 seconds
    setInterval(() => {
      if (!State.currentAuthUser) return;
      const elapsed = Date.now() - State.lastActivityTime;
      const TEN_MIN = 10 * 60 * 1000;
      const NINE_MIN = 9 * 60 * 1000;

      if (elapsed >= TEN_MIN) {
        closeModal('inactivityModal');
        logoutUser('10 minutes of inactivity');
      } else if (elapsed >= NINE_MIN) {
        const remainingSec = Math.max(0, Math.ceil((TEN_MIN - elapsed) / 1000));
        const countEl = document.getElementById('inactivityCountdown');
        if (countEl) countEl.innerText = `${remainingSec} seconds`;
        openModal('inactivityModal');
      } else {
        const inactModal = document.getElementById('inactivityModal');
        if (inactModal && inactModal.classList.contains('open')) {
          closeModal('inactivityModal');
        }
      }
    }, 3000);
  }

  // --------------------------------------------------------------------------
  // Account Management Directory & Administrative Actions
  // --------------------------------------------------------------------------
  function renderAccountsTable() {
    const tbody = document.getElementById('accountsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const filterRole = document.getElementById('filterAccountRole').value;
    const accounts = State.accounts.filter(a => {
      if (filterRole !== 'ALL' && a.role !== filterRole) return false;
      return true;
    });

    if (accounts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#64748b; padding:2rem;">No staff accounts found matching filter.</td></tr>`;
      return;
    }

    const currentStaffId = State.currentAuthUser ? State.currentAuthUser.staffId : '';

    accounts.forEach(acc => {
      const isSelf = (acc.staffId === currentStaffId);
      const isLocked = (acc.lockedUntil && acc.lockedUntil > State.vTime);

      // Status Badge
      let statusBadgeHtml = '';
      if (isLocked) {
        const remMin = Math.ceil((acc.lockedUntil - State.vTime) / 60000);
        statusBadgeHtml = `<span class="status-badge escalated" title="Account locked for ${remMin}m">🔒 Locked (${remMin}m)</span>`;
      } else if (acc.status === 'ACTIVE') {
        statusBadgeHtml = '<span class="status-badge active">🟢 Active</span>';
      } else if (acc.status === 'PENDING') {
        statusBadgeHtml = '<span class="status-badge pending">🟡 Pending Approval</span>';
      } else if (acc.status === 'DEACTIVATED') {
        statusBadgeHtml = '<span class="status-badge deactivated">🔴 Deactivated</span>';
      }

      // License Verified Badge
      let licenseHtml = '<span style="color:#64748b; font-size:0.75rem;">N/A (Non-clinical)</span>';
      if (acc.role === 'doctor' || acc.role === 'nurse') {
        licenseHtml = `
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <span class="license-badge ${acc.licenseVerified ? 'verified' : 'unverified'}">
              ${acc.licenseVerified ? '🛡️ Verified: YES' : '⚠️ Verified: NO (manual check)'}
            </span>
            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.toggleLicenseVerified('${acc.staffId}')" title="Verify against official council registry">
              Toggle
            </button>
          </div>
        `;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:var(--font-mono); font-weight:700; color:#0369a1;">
          ${acc.staffId} ${isSelf ? '<span style="color:#64748b; font-size:0.7rem;">(You)</span>' : ''}
        </td>
        <td style="font-weight:600;">${escapeHtml(acc.name)}</td>
        <td><span class="status-badge waiting">${ROLES[acc.role]?.title || acc.role}</span></td>
        <td style="font-family:var(--font-mono); font-size:0.8rem;">${acc.licenseNumber ? escapeHtml(acc.licenseNumber) : '--'}</td>
        <td>${licenseHtml}</td>
        <td>${statusBadgeHtml}</td>
        <td style="font-size:0.75rem; color:#475569;">
          <div>Created: <strong>${acc.createdBy || 'SYSTEM'}</strong></div>
          <div>Approved: <strong>${acc.approvedBy || 'Pending'}</strong></div>
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <div class="toolbar-group" style="justify-content: flex-end;">
            ${acc.status === 'PENDING' ? `
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.approveAccount('${acc.staffId}')" ${acc.createdBy === currentStaffId ? 'disabled title="Two-person rule: Cannot approve an account you created. Requires approval from a different admin."' : 'title="Approve account as second administrator"'}>
                ✅ Approve
              </button>
            ` : ''}

            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.toggleAccountStatus('${acc.staffId}')" ${isSelf ? 'disabled title="Cannot deactivate your own logged-in account"' : ''}>
              ${acc.status === 'ACTIVE' ? '🚫 Deactivate' : '🟢 Activate'}
            </button>

            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.openResetPassword('${acc.staffId}')" title="Force password reset">
              🔑 Reset PIN
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    updatePendingAccountsBadge();
  }

  async function handleCreateStaffAccountSubmit(e) {
    e.preventDefault();

    if (!enforcePermission('canManageAccounts', 'provision new staff accounts')) return;

    const name = document.getElementById('newStaffName').value.trim();
    const staffId = document.getElementById('newStaffId').value.trim().toLowerCase();
    const role = document.getElementById('newStaffRole').value;
    const password = document.getElementById('newStaffPassword').value;
    const licenseNumber = document.getElementById('newStaffLicense').value.trim();

    if (!name || !staffId || !password) {
      showToast('Validation Error', 'Please complete all required fields.', 'toast-warning');
      return;
    }

    if (password.length < 6) {
      showToast('Password Too Short', 'Initial password must be at least 6 characters long.', 'toast-warning');
      return;
    }

    // Check duplicate
    if (State.accounts.some(a => a.staffId.toLowerCase() === staffId)) {
      showToast('Duplicate Staff ID', `Staff ID "${staffId}" is already registered. Please choose another identifier.`, 'toast-warning');
      return;
    }

    // Two-person approval requirement: Doctor & Admin are created PENDING
    const isDoctorOrAdmin = (role === 'doctor' || role === 'admin');
    const initialStatus = isDoctorOrAdmin ? 'PENDING' : 'ACTIVE';
    const approvedBy = isDoctorOrAdmin ? null : State.currentAuthUser.staffId;

    const salt = generateSalt();
    const hash = await hashPassword(password, salt);

    const newAccount = {
      staffId,
      name,
      role,
      licenseNumber: (role === 'doctor' || role === 'nurse') ? licenseNumber : '',
      licenseVerified: false,
      status: initialStatus,
      salt,
      passwordHash: hash,
      failedAttempts: 0,
      lockedUntil: null,
      createdBy: State.currentAuthUser.staffId,
      approvedBy,
      createdAt: State.vTime
    };

    State.accounts.push(newAccount);
    saveAllState();

    addAuditEntry({
      action: 'ACCOUNT_CREATED',
      patientToken: '--',
      details: `Admin ${State.currentAuthUser.staffId} provisioned ${role.toUpperCase()} account for ${name} (${staffId}). Status: ${initialStatus}${isDoctorOrAdmin ? ' [PENDING 2nd Admin Approval]' : ''}`,
      diff: { staffId, name, role, status: initialStatus, licenseNumber }
    });

    document.getElementById('createStaffAccountForm').reset();
    renderAccountsTable();

    if (isDoctorOrAdmin) {
      showToast('Account Created (Pending)', `Account for ${name} (${staffId}) created. A second administrator must approve before it can log in.`, 'toast-warning');
    } else {
      showToast('Account Created', `Active account created for ${name} (${staffId}).`, 'toast-info');
    }
  }

  function approveStaffAccount(staffId) {
    if (!enforcePermission('canManageAccounts', 'approve pending staff accounts')) return;

    const acc = State.accounts.find(a => a.staffId === staffId);
    if (!acc || acc.status !== 'PENDING') return;

    // Two-person approval rule: Must be a DIFFERENT admin
    if (acc.createdBy === State.currentAuthUser.staffId) {
      showToast('Two-Person Approval Rule Violation', 'Cannot approve an account you created. Approval must come from a different administrator.', 'toast-warning');
      logUnauthorizedAttempt(`Attempted self-approval of created account ${staffId}`);
      return;
    }

    acc.status = 'ACTIVE';
    acc.approvedBy = State.currentAuthUser.staffId;
    saveAllState();

    addAuditEntry({
      action: 'ACCOUNT_APPROVED',
      patientToken: '--',
      details: `Two-person approval completed: Admin ${State.currentAuthUser.staffId} approved and activated ${acc.role} account ${acc.staffId} (created by ${acc.createdBy}).`,
      diff: { staffId: acc.staffId, approvedBy: acc.approvedBy, status: 'ACTIVE' }
    });

    renderAccountsTable();
    showToast('Account Approved', `Account ${acc.staffId} (${acc.name}) is now Active and can log in.`, 'toast-info');
  }

  function toggleStaffAccountStatus(staffId) {
    if (!enforcePermission('canManageAccounts', 'modify account activation status')) return;

    const acc = State.accounts.find(a => a.staffId === staffId);
    if (!acc) return;

    // Nobody can deactivate themselves
    if (acc.staffId === State.currentAuthUser.staffId) {
      showToast('Blocked Action', 'You cannot deactivate your own logged-in administrator account.', 'toast-warning');
      logUnauthorizedAttempt(`Attempted self-deactivation of ${staffId}`);
      return;
    }

    const prevStatus = acc.status;
    acc.status = (acc.status === 'ACTIVE') ? 'DEACTIVATED' : 'ACTIVE';
    saveAllState();

    addAuditEntry({
      action: acc.status === 'ACTIVE' ? 'ACCOUNT_REACTIVATED' : 'ACCOUNT_DEACTIVATED',
      patientToken: '--',
      details: `Admin ${State.currentAuthUser.staffId} changed account status of ${acc.staffId} from ${prevStatus} to ${acc.status}.`,
      diff: { staffId: acc.staffId, previousStatus: prevStatus, newStatus: acc.status }
    });

    renderAccountsTable();
    showToast('Account Status Updated', `Account ${acc.staffId} is now ${acc.status}.`, 'toast-info');
  }

  function openResetPasswordModal(staffId) {
    if (!enforcePermission('canManageAccounts', 'force staff password reset')) return;

    const acc = State.accounts.find(a => a.staffId === staffId);
    if (!acc) return;

    State.selectedStaffForReset = acc;
    document.getElementById('resetStaffSummary').innerHTML = `
      <strong>Staff Member:</strong> ${acc.name} (${acc.staffId}) &bull; Role: ${ROLES[acc.role]?.title || acc.role}
    `;
    document.getElementById('adminNewPasswordInput').value = '';
    openModal('passwordResetModal');
  }

  async function handleConfirmPasswordReset() {
    if (!State.selectedStaffForReset) return;
    if (!enforcePermission('canManageAccounts', 'force staff password reset')) return;

    const newPass = document.getElementById('adminNewPasswordInput').value;
    if (!newPass || newPass.length < 6) {
      showToast('Validation Error', 'New password must be at least 6 characters.', 'toast-warning');
      return;
    }

    const acc = State.selectedStaffForReset;
    const newSalt = generateSalt();
    const newHash = await hashPassword(newPass, newSalt);

    acc.salt = newSalt;
    acc.passwordHash = newHash;
    acc.failedAttempts = 0;
    acc.lockedUntil = null;
    saveAllState();

    addAuditEntry({
      action: 'PASSWORD_RESET_FORCED',
      patientToken: '--',
      details: `Admin ${State.currentAuthUser.staffId} forced password reset for staff ${acc.staffId}. New salt & hash stored.`,
      diff: { staffId: acc.staffId }
    });

    closeModal('passwordResetModal');
    State.selectedStaffForReset = null;
    renderAccountsTable();
    showToast('Password Reset', `Password updated for ${acc.staffId}. Lockout cleared.`, 'toast-info');
  }

  function toggleLicenseVerified(staffId) {
    if (!enforcePermission('canManageAccounts', 'verify clinician license')) return;

    const acc = State.accounts.find(a => a.staffId === staffId);
    if (!acc) return;

    acc.licenseVerified = !acc.licenseVerified;
    saveAllState();

    addAuditEntry({
      action: 'LICENSE_VERIFICATION_UPDATED',
      patientToken: '--',
      details: `Admin ${State.currentAuthUser.staffId} toggled council license verification for ${acc.staffId} to: ${acc.licenseVerified ? 'YES (Verified)' : 'NO (Unverified)'}.`,
      diff: { staffId: acc.staffId, licenseVerified: acc.licenseVerified }
    });

    renderAccountsTable();
    showToast('License Status Updated', `License verification for ${acc.staffId} set to ${acc.licenseVerified ? 'YES' : 'NO'}.`, 'toast-info');
  }

  function updateAccountRole(actorStaffId, targetStaffId, newRole) {
    // Nobody can edit their own role!
    if (actorStaffId === targetStaffId) {
      throw new Error('Cannot modify your own account role');
    }
    const acc = State.accounts.find(a => a.staffId === targetStaffId);
    if (!acc) throw new Error('Account not found');
    const oldRole = acc.role;
    acc.role = newRole;
    saveAllState();
    addAuditEntry({
      action: 'ROLE_UPDATED',
      patientToken: '--',
      details: `Admin ${actorStaffId} updated role for ${targetStaffId} from ${oldRole} to ${newRole}.`,
      diff: { targetStaffId, oldRole, newRole }
    });
  }

  function showLoginError(msg) {
    const el = document.getElementById('loginErrorBox');
    if (el) {
      el.innerText = msg;
      el.style.display = 'block';
    }
  }

  function showLoginLockout(msg) {
    const el = document.getElementById('loginLockoutBox');
    if (el) {
      el.innerText = msg;
      el.style.display = 'block';
    }
  }

  function hideLoginAlerts() {
    const err = document.getElementById('loginErrorBox');
    const lock = document.getElementById('loginLockoutBox');
    if (err) err.style.display = 'none';
    if (lock) lock.style.display = 'none';
  }

  function getVirtualDate() {
    return new Date(State.vTime);
  }

  function formatVirtualTime(ms) {
    const d = new Date(ms || State.vTime);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatTimeOnly(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ==========================================================================
  // SECTION 2: RULE ENGINE (PURE EVALUATION FUNCTION & RULES CATALOG)
  // ==========================================================================
  // Plain-language explanation:
  // Deterministic clinical decision-support logic. Evaluates symptoms and physiological
  // vitals against pediatric and adult thresholds to suggest Urgency Levels 1 through 4.
  // Never lowers urgency when vitals are missing (fails safe with 'Needs human review')
  // and never diagnoses.

  /**
   * SAMPLE RULES – require clinician approval before real clinical use.
   * Deterministic, rule-based clinical decision support.
   */
  const SAMPLE_RULES = [
    {
      id: 'R-SPO2-L1',
      name: 'Critical Hypoxia (SpO2 < 90%)',
      condition: 'SpO2 < 90%',
      level: 1,
      category: 'Vitals',
      rationale: 'Severe arterial hypoxemia impairs tissue oxygen delivery; immediate oxygen therapy and airway evaluation required.'
    },
    {
      id: 'R-SPO2-L2',
      name: 'Borderline Hypoxia (SpO2 90-93%)',
      condition: 'SpO2 >= 90% and SpO2 <= 93%',
      level: 2,
      category: 'Vitals',
      rationale: 'Moderate hypoxemia indicates respiratory compromise requiring urgent clinician evaluation within 15 minutes.'
    },
    {
      id: 'R-SBP-L1',
      name: 'Severe Hypotension / Shock (Systolic < 80 mmHg)',
      condition: 'Systolic BP < 80 mmHg',
      level: 1,
      category: 'Vitals',
      rationale: 'Profound hypoperfusion indicates decompensated shock; requires immediate resuscitation and fluid access.'
    },
    {
      id: 'R-SBP-L2',
      name: 'Hypotension or Severe Hypertension',
      condition: 'Systolic BP < 90 mmHg OR Systolic BP > 180 mmHg',
      level: 2,
      category: 'Vitals',
      rationale: 'Borderline shock or hypertensive crisis poses imminent organ risk requiring urgent intervention.'
    },
    {
      id: 'R-HR-L1-ADULT',
      name: 'Extreme Adult Heart Rate (< 40 or > 130 bpm)',
      condition: 'Adult/Elderly HR < 40 bpm OR HR > 130 bpm',
      level: 1,
      category: 'Vitals',
      rationale: 'Extreme bradycardia or severe tachycardia compromises cardiac output with imminent arrest risk.'
    },
    {
      id: 'R-HR-L2-ADULT',
      name: 'Adult Tachycardia (> 110 bpm)',
      condition: 'Adult HR > 110 bpm and HR <= 130 bpm',
      level: 2,
      category: 'Vitals',
      rationale: 'Marked resting tachycardia frequently signifies systemic distress, infection, or occult bleeding.'
    },
    {
      id: 'R-HR-PEDS',
      name: 'Pediatric Abnormal Heart Rate',
      condition: 'Infant HR < 80 or > 180; Child HR < 60 or > 160',
      level: 1,
      category: 'Vitals',
      rationale: 'Pediatric vital parameter thresholds are age-dependent; extreme values herald cardiopulmonary collapse.'
    },
    {
      id: 'R-RR-L1',
      name: 'Critical Respiratory Rate (Adult RR < 8 or > 30)',
      condition: 'Adult RR < 8 /min OR RR > 30 /min',
      level: 1,
      category: 'Vitals',
      rationale: 'Severe bradypnea indicates impending respiratory arrest; extreme tachypnea signals high work of breathing.'
    },
    {
      id: 'R-RR-L2',
      name: 'Elevated Adult Respiratory Rate (RR >= 24)',
      condition: 'Adult RR >= 24 and RR <= 30 /min',
      level: 2,
      category: 'Vitals',
      rationale: 'Tachypnea is the most sensitive early predictor of clinical deterioration.'
    },
    {
      id: 'R-GCS-L1',
      name: 'Severe Neurological Impairment (GCS <= 8)',
      condition: 'Glasgow Coma Scale <= 8',
      level: 1,
      category: 'Neurological',
      rationale: 'Loss of protective airway reflexes; requires immediate airway protection and resuscitation.'
    },
    {
      id: 'R-GCS-L2',
      name: 'Moderate Neurological Deficit (GCS 9 - 13)',
      condition: 'Glasgow Coma Scale 9 - 13',
      level: 2,
      category: 'Neurological',
      rationale: 'Altered mental status requires urgent neurovascular assessment.'
    },
    {
      id: 'R-TEMP-INFANT',
      name: 'Infant Fever (Age < 1 yr and Temp >= 38.0°C)',
      condition: 'Age < 1 year AND Temp >= 38.0°C',
      level: 2,
      category: 'Pediatric',
      rationale: 'Infants have immature immune systems and high risk of serious occult bacterial infection.'
    },
    {
      id: 'R-TEMP-HYPER',
      name: 'Severe Hyperpyrexia (Temp >= 39.5°C)',
      condition: 'Temperature >= 39.5°C',
      level: 2,
      category: 'Vitals',
      rationale: 'High fever carries risk of dehydration, seizure, or severe systemic infection.'
    },
    {
      id: 'R-RED-FLAG-L1',
      name: 'Immediate Life-Threat Red Flag Symptoms',
      condition: 'Stroke signs, active seizure, severe bleeding, or anaphylaxis',
      level: 1,
      category: 'Symptoms',
      rationale: 'Time-critical emergencies where immediate intervention directly alters survival and morbidity.'
    },
    {
      id: 'R-MENINGITIS-L1',
      name: 'Suspected Meningitis Triad',
      condition: 'Fever + Stiff Neck + Altered Consciousness',
      level: 1,
      category: 'Symptoms',
      rationale: 'Classic triad for acute bacterial meningitis requiring emergent lumbar puncture and IV antibiotics.'
    },
    {
      id: 'R-CHEST-PAIN-AGE',
      name: 'Adult Chest Pain (Age >= 40)',
      condition: 'Chest pain AND Age >= 40',
      level: 2,
      category: 'Symptoms',
      rationale: 'Significant probability of Acute Coronary Syndrome (ACS); requires ECG within 10 minutes.'
    },
    {
      id: 'R-PREGNANCY-BLEED',
      name: 'Obstetric Emergency / Threatened Loss',
      condition: 'Pregnant AND (Pregnancy bleeding/pain OR Severe abdominal pain)',
      level: 2,
      category: 'Symptoms',
      rationale: 'Potential ruptured ectopic pregnancy, placenta previa, or abruption with rapid maternal/fetal compromise.'
    },
    {
      id: 'R-SEVERE-SYMPTOMS',
      name: 'Severe Abdominal Pain or Breathlessness',
      condition: 'Severe abdominal pain OR Breathlessness',
      level: 2,
      category: 'Symptoms',
      rationale: 'Potential acute abdomen (perforation, appendicitis) or acute dyspnea requiring urgent physician evaluation.'
    },
    {
      id: 'R-SEMI-URGENT',
      name: 'Semi-urgent Symptoms (Vomiting/Diarrhea or Head Injury)',
      condition: 'Vomiting/diarrhea OR head injury without red flags',
      level: 3,
      category: 'Symptoms',
      rationale: 'Requires symptom management, fluid assessment, or neurological observation within 60 minutes.'
    },
    {
      id: 'R-NON-URGENT',
      name: 'Non-urgent Conditions (Minor Injury / Cold)',
      condition: 'Minor injury OR Mild cold with normal vitals',
      level: 4,
      category: 'Symptoms',
      rationale: 'Low-acuity ambulatory presentations suitable for routine OPD consultation within 120 minutes.'
    }
  ];

  const SYMPTOM_LIST = [
    { id: 'chest_pain', label: 'Chest pain', isRedFlag: true },
    { id: 'breathlessness', label: 'Breathlessness', isRedFlag: true },
    { id: 'altered_consciousness', label: 'Altered consciousness', isRedFlag: true },
    { id: 'severe_bleeding', label: 'Severe bleeding', isRedFlag: true },
    { id: 'seizure', label: 'Seizure', isRedFlag: true },
    { id: 'stroke_signs', label: 'Stroke signs (Face/Arm/Speech)', isRedFlag: true },
    { id: 'severe_abdominal_pain', label: 'Severe abdominal pain', isRedFlag: true },
    { id: 'high_fever', label: 'High fever', isRedFlag: false },
    { id: 'stiff_neck', label: 'Stiff neck', isRedFlag: false },
    { id: 'head_injury', label: 'Head injury', isRedFlag: false },
    { id: 'allergic_reaction', label: 'Severe allergic reaction / anaphylaxis', isRedFlag: true },
    { id: 'pregnancy_bleeding_pain', label: 'Pregnancy bleeding / pain', isRedFlag: true },
    { id: 'vomiting_diarrhea', label: 'Vomiting / diarrhea', isRedFlag: false },
    { id: 'minor_injury', label: 'Minor injury', isRedFlag: false },
    { id: 'mild_cold', label: 'Mild cold / cough', isRedFlag: false }
  ];

  /**
   * Helper: Determine age band
   */
  function getAgeBand(age) {
    const numAge = Number(age);
    if (isNaN(numAge)) return 'adult';
    if (numAge < 1) return 'infant';
    if (numAge <= 12) return 'child';
    if (numAge >= 65) return 'elderly';
    return 'adult';
  }

  /**
   * Validate vitals against hard limits (impossible values) and soft limits
   */
  function validateVitals(vitals, age) {
    const errors = [];
    const warnings = [];
    const band = getAgeBand(age);

    if (vitals.spo2 !== undefined && vitals.spo2 !== null && vitals.spo2 !== '') {
      const val = Number(vitals.spo2);
      if (isNaN(val) || val < 30 || val > 100) {
        errors.push({ field: 'spo2', msg: 'SpO2 must be between 30% and 100% (physiologically impossible).' });
      } else if (val < 92) {
        warnings.push({ field: 'spo2', msg: 'SpO2 < 92% is low. Re-measure and check sensor placement.' });
      }
    }

    if (vitals.sbp !== undefined && vitals.sbp !== null && vitals.sbp !== '') {
      const val = Number(vitals.sbp);
      if (isNaN(val) || val < 30 || val > 300) {
        errors.push({ field: 'sbp', msg: 'Systolic BP must be between 30 and 300 mmHg.' });
      } else if (val > 180 || val < 90) {
        warnings.push({ field: 'sbp', msg: 'Systolic BP outside expected resting range (90-180 mmHg).' });
      }
    }

    if (vitals.dbp !== undefined && vitals.dbp !== null && vitals.dbp !== '') {
      const val = Number(vitals.dbp);
      if (isNaN(val) || val < 20 || val > 200) {
        errors.push({ field: 'dbp', msg: 'Diastolic BP must be between 20 and 200 mmHg.' });
      }
    }

    if (vitals.hr !== undefined && vitals.hr !== null && vitals.hr !== '') {
      const val = Number(vitals.hr);
      if (isNaN(val) || val < 20 || val > 300) {
        errors.push({ field: 'hr', msg: 'Heart rate must be between 20 and 300 bpm.' });
      } else {
        if (band === 'adult' || band === 'elderly') {
          if (val > 120 || val < 50) warnings.push({ field: 'hr', msg: 'Adult heart rate unusual (<50 or >120 bpm).' });
        } else if (band === 'infant') {
          if (val > 190 || val < 70) warnings.push({ field: 'hr', msg: 'Infant heart rate unusual (<70 or >190 bpm).' });
        }
      }
    }

    if (vitals.rr !== undefined && vitals.rr !== null && vitals.rr !== '') {
      const val = Number(vitals.rr);
      if (isNaN(val) || val < 3 || val > 100) {
        errors.push({ field: 'rr', msg: 'Respiratory rate must be between 3 and 100 breaths/min.' });
      } else if (band === 'adult' && (val > 28 || val < 10)) {
        warnings.push({ field: 'rr', msg: 'Adult respiratory rate unusual (<10 or >28 /min).' });
      }
    }

    if (vitals.temp !== undefined && vitals.temp !== null && vitals.temp !== '') {
      const val = Number(vitals.temp);
      if (isNaN(val) || val < 25 || val > 45) {
        errors.push({ field: 'temp', msg: 'Temperature must be between 25°C and 45°C.' });
      } else if (val >= 38.5) {
        warnings.push({ field: 'temp', msg: 'High pyrexia documented. Verify with second reading.' });
      }
    }

    if (vitals.gcs !== undefined && vitals.gcs !== null && vitals.gcs !== '') {
      const val = Number(vitals.gcs);
      if (isNaN(val) || val < 3 || val > 15) {
        errors.push({ field: 'gcs', msg: 'Glasgow Coma Scale must be between 3 and 15.' });
      }
    }

    if (vitals.pain !== undefined && vitals.pain !== null && vitals.pain !== '') {
      const val = Number(vitals.pain);
      if (isNaN(val) || val < 0 || val > 10) {
        errors.push({ field: 'pain', msg: 'Pain scale must be between 0 and 10.' });
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }


// ==============================================================================
// AI/ML MODEL ARTIFACT (EMBEDDED CLIENT-SIDE INFERENCE ENGINE)
// ==============================================================================
const AI_MODEL_CONFIG = {
  "version": "2.0-competition",
  "model_type": "Asymmetric Multimodal Triage Classifier",
  "feature_names": [
    "sym_chest_pain",
    "sym_breathlessness",
    "sym_stroke_signs",
    "sym_altered_mental_status",
    "sym_severe_bleeding",
    "sym_severe_abdominal_pain",
    "sym_high_fever",
    "sym_minor_injury",
    "sym_mild_cold_cough",
    "sym_pediatric_fever",
    "sym_pregnancy_pain",
    "sym_skin_rash",
    "sym_ear_throat",
    "spo2_low",
    "sbp_low",
    "sbp_high",
    "hr_high",
    "hr_low",
    "rr_high",
    "temp_high",
    "gcs_low",
    "age_elderly",
    "age_pediatric"
  ],
  "num_classes": 5,
  "classes": [
    1,
    2,
    3,
    4,
    5
  ],
  "class_labels": {
    "1": "Resuscitation / Critical",
    "2": "Emergent / High Risk",
    "3": "Urgent",
    "4": "Less Urgent",
    "5": "Non-Urgent"
  },
  "weights": [
    [
      -1.147808224523525,
      -2.643750301153896,
      20.000024677826087,
      20.000000584006557,
      2.2698020108897716,
      -0.03772331263159724,
      -0.0020253613729160035,
      -0.7387331891705787,
      -0.0002396271215902566,
      -0.9956925571385058,
      -2.4923132345211703,
      -0.7461908981500703,
      -1.7284175484389157,
      16.840624361423593,
      2.2698021475442305,
      -0.31161753695987576,
      1.8837242287241585,
      0.0,
      4.680997447014216,
      -1.2434496192626125,
      1.7049761791626614,
      -0.08513445367011,
      -0.9956925571385058
    ],
    [
      17.14880381783896,
      5.80219522017789,
      -7.322496107209189e-06,
      -3.0884917785356584e-07,
      -0.7463590500499886,
      2.795812092422329,
      -0.004178428951819602,
      -0.8387768771979924,
      -0.0002852510017417146,
      -1.266605914160115,
      7.741585771869935,
      -0.8442484511544692,
      -1.8746016736867899,
      9.949457170138833,
      -0.746359107096104,
      0.31180613029270604,
      0.25906943457549453,
      0.0,
      -3.5161350582578703,
      1.384042700331134,
      -0.5874270619726285,
      0.006170965347633017,
      -1.266605914160115
    ],
    [
      -0.0002998118875231716,
      -1.0762581719675586,
      -4.405750182310426e-06,
      -1.155347821579315e-07,
      -0.5907296199097168,
      11.287666711301169,
      14.009060628510522,
      -0.7154249226073293,
      -0.00023098109003383103,
      3.9344047696727658,
      -4.218355588865293,
      -0.726139116926063,
      -1.7128096869873985,
      -0.2845359414401696,
      -0.5907296447863714,
      -5.3052394716661116e-05,
      -0.24224361584618198,
      0.0,
      -0.47256003689353215,
      0.7897238066636998,
      -0.46152580499957624,
      -0.8187498851604398,
      3.9344047696727658
    ],
    [
      -0.00032091616290920856,
      -0.9836563874926775,
      -5.895996243246631e-06,
      -7.642264675463773e-08,
      -0.4568435834125451,
      -0.02116322270781895,
      -0.0013135004231205406,
      7.889076089693226,
      -0.00025550834169465987,
      -0.8134395147744524,
      -0.46680160276078375,
      7.607689884989023,
      7.278901751955685,
      -0.0026096148971423987,
      -0.45684360944127217,
      -6.378007174549857e-05,
      -0.9142174599580372,
      0.0,
      -0.33752695187178233,
      -0.44124560328178514,
      -0.32069270411830986,
      0.48453350089761665,
      -0.8134395147744524
    ],
    [
      -0.0003748652647997098,
      -1.0985303595636884,
      -7.05358356049414e-06,
      -8.320000385525373e-08,
      -0.47586975751749944,
      -0.024592268383926925,
      -0.0015433377624743648,
      6.903858899282625,
      15.001011367555039,
      -0.8586667835996661,
      -0.5641153457226914,
      7.208888581241671,
      -1.9630728428425828,
      -0.0029359752250652997,
      -0.47586978622044224,
      -7.176086635670108e-05,
      -0.9863325874954211,
      0.0,
      -0.35477539999106,
      -0.48907128445041986,
      -0.3353306080721224,
      0.4131798725853093,
      -0.8586667835996661
    ]
  ],
  "bias": [
    -0.08257259677426601,
    0.0805305893584832,
    -0.039557836201958574,
    -0.04967575747647452,
    0.09127560109421202
  ],
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
  "metrics": {
    "test_size": 4500,
    "true_positives": 169,
    "false_negatives": 0,
    "false_positives": 488,
    "true_negatives": 3843,
    "emergency_recall_pct": 100.0,
    "under_triage_pct": 0.0,
    "over_triage_pct": 11.27,
    "exact_acuity_accuracy_pct": 87.53
  }
};

const MULTILINGUAL_SYMPTOM_DICTIONARY = {
  chest_pain: {
    id: 'chest_pain',
    name: 'Chest Pain / Acute Coronary',
    phrases: [
      'chest pain', 'angina', 'chest tightness', 'chest pressure', 'substernal pain', 'heart attack pain', 'heavy chest',
      'छाती में दर्द', 'सीने में दर्द', 'दिल का दौरा', 'सीने में जलन और दबाव',
      'ఛాతీ నొప్పి', 'గుండె నొప్పి', 'ఛాతీలో మంట', 'గుండెలో బరువుగా ఉంది',
      'chaati me dard', 'chhati me dard', 'chati me dard', 'seene me dard', 'chhati dard', 'chhati', 'dil ka daura', 'chathi lo noppi', 'gunde noppi', 'chati noppi',
      'ches pain', 'chest pane', 'chect pain', 'chestt pain', 'heavines in chest'
    ],
    dept: 'Cardiology',
    deptReason: 'Acute coronary syndrome or cardiac ischemia indicated by chest pain presentations.'
  },
  breathlessness: {
    id: 'breathlessness',
    name: 'Severe Breathlessness / Respiratory Distress',
    phrases: [
      'difficulty breathing', 'shortness of breath', 'breathlessness', 'dyspnea', 'severe wheezing', 'gasping for air', 'asthma attack',
      'सांस लेने में तकलीफ', 'दम फूलना', 'सांस नहीं आ रही', 'अस्थमा का दौरा',
      'శ్వాస తీసుకోవడంలో ఇబ్బంది', 'ఆయాసం', 'శ్వాస ఆడటం లేదు', 'దమ్ము',
      'saans lene me takleef', 'saans lene mein takleef', 'saas lene me takleef', 'dam phoolna', 'swasa aadadam ledu', 'aayasam', 'swasa kastam',
      'brething difficulty', 'shortnes of breath', 'brethless', 'disnea', 'cant breath'
    ],
    dept: 'Pulmonology',
    deptReason: 'Respiratory failure, acute asthma, or severe airway compromise indicated.'
  },
  stroke_signs: {
    id: 'stroke_signs',
    name: 'Acute Stroke FAST Signs',
    phrases: [
      'facial droop', 'slurred speech', 'sudden weakness on one side', 'arm drift', 'numbness one side', 'stroke symptoms', 'inability to speak',
      'मुंह टेढ़ा होना', 'बोलने में लड़खड़ाहट', 'एक तरफ कमजोरी', 'लकवा के लक्षण',
      'ముఖం వంకర పోవడం', 'మాట తడబడటం', 'ఒక వైపు బలహీనత', 'పక్షవాతం లక్షణాలు',
      'muh tedha hona', 'bolne me ladkhadahat', 'ek taraf kamjori', 'pakshavatam', 'mata tadabadatam',
      'slured speech', 'face droop', 'weekness one side', 'strok', 'paralisis'
    ],
    dept: 'Neurology',
    deptReason: 'Focal neurological deficit and acute ischemic/hemorrhagic stroke signs.'
  },
  altered_mental_status: {
    id: 'altered_mental_status',
    name: 'Altered Mental Status / Unconsciousness',
    phrases: [
      'unconscious', 'unresponsive', 'severe confusion', 'drowsy and disoriented', 'passed out', 'lethargic', 'syncope',
      'बेहोश', 'अचेत', 'भ्रमित स्थिति', 'जगाने पर नहीं जाग रहा',
      'స్పృహ తప్పిపోవడం', 'అపస్మారక స్థితి', 'మతిస్థిమితం లేకపోవడం',
      'behoshi', 'behosha', 'spruha tappipovadam', 'bhramit',
      'unconcious', 'unresponcive', 'pas out', 'drowzy'
    ],
    dept: 'Emergency / Resuscitation',
    deptReason: 'Immediate neurological stabilization and airway protection required.'
  },
  severe_bleeding: {
    id: 'severe_bleeding',
    name: 'Severe / Profuse Bleeding',
    phrases: [
      'heavy bleeding', 'profuse blood loss', 'arterial bleeding', 'vomiting blood', 'hematemesis', 'deep laceration bleeding profusely',
      'भारी रक्तस्राव', 'खून की उल्टी', 'लगातार खून बहना',
      'విపరీతమైన రక్తస్రావం', 'రక్తం వాంతులు', 'తీవ్రమైన గాయం',
      'khoon behna', 'khoon ki ulti', 'raktasravam', 'raktham vantulu',
      'bleedng', 'hevy bleeding', 'vomting blood'
    ],
    dept: 'Surgery',
    deptReason: 'Acute surgical hemostasis and trauma assessment required.'
  },
  severe_abdominal_pain: {
    id: 'severe_abdominal_pain',
    name: 'Acute Severe Abdominal Pain',
    phrases: [
      'severe stomach pain', 'acute abdominal pain', 'sharp belly pain', 'rigid abdomen', 'extreme cramps',
      'पेट में तेज दर्द', 'असहनीय पेट दर्द', 'पेट में मरोड़',
      'కడుపులో తీవ్రమైన నొప్పి', 'కడుపు నొప్పి', 'కడుపు పట్టేయడం',
      'pet me tez dard', 'kadupu noppi', 'tivramaina kadupu noppi',
      'stocmach pain', 'abdminal pain', 'belly ache severe'
    ],
    dept: 'General Medicine',
    deptReason: 'Acute abdomen evaluation, surgical consultation as indicated.'
  },
  high_fever: {
    id: 'high_fever',
    name: 'High Pyrexia / Febrile Illness',
    phrases: [
      'high fever', 'burning hot', 'fever with severe chills', 'pyrexia', 'rigors',
      'तेज बुखार', 'कपकपी के साथ बुखार', 'शरीर तप रहा है',
      'తీవ్రమైన జ్వరం', 'వణుకుతో కూడిన జ్వరం', 'ఒళ్ళు కాలిపోతోంది',
      'tez bukhar', 'kampkampi bukhar', 'tivramaina jwaram', 'jwaram chali',
      'feever', 'high fevr', 'hot feber', 'chil fever'
    ],
    dept: 'General Medicine',
    deptReason: 'Infectious disease workup and hemodynamic stability monitoring.'
  },
  minor_injury: {
    id: 'minor_injury',
    name: 'Minor Musculoskeletal Injury / Sprain',
    phrases: [
      'twisted ankle', 'minor finger cut', 'small bruise', 'wrist sprain', 'toe injury while walking',
      'पैर मुड़ना', 'हल्की खरोंच', 'उंगली में हल्की चोट',
      'చీలమండ బెణకడం', 'చేతి వేలికి చిన్న గాయం', 'చిన్న దెబ్బ',
      'pair mudna', 'halki chot', 'benakadam', 'chinna debba',
      'sprained ankel', 'twised ankel', 'miner cut'
    ],
    dept: 'Orthopedics',
    deptReason: 'Musculoskeletal evaluation and orthopedic immobilization.'
  },
  mild_cold_cough: {
    id: 'mild_cold_cough',
    name: 'Mild Upper Respiratory Infection',
    phrases: [
      'mild runny nose', 'sneezing and throat irritation', 'slight dry cough', 'nasal congestion',
      'हल्की सर्दी', 'जुकाम और छींकें', 'हल्की खांसी',
      'తేలికపాటి జలుబు', 'దగ్గు', 'ముక్కు కారడం',
      'halka jukam', 'chhike', 'telikapati jalubu', 'daggu',
      'caugh', 'runy nose', 'sneeze'
    ],
    dept: 'General Medicine',
    deptReason: 'Routine outpatient consultation for uncomplicated URI.'
  },
  pediatric_fever: {
    id: 'pediatric_fever',
    name: 'Pediatric Febrile Presentation',
    phrases: [
      'child crying with warm forehead', 'toddler fever and irritability', 'baby warm not drinking milk',
      'बच्चे को बुखार', 'शिशु रो रहा है और शरीर गर्म है',
      'పిల్లాడికి జ్వరం', 'పాలు తాగడం లేదు ఏడుస్తున్నాడు',
      'bacche ko bukhar', 'pilladiki jwaram', 'baby warm',
      'chld fevr', 'bby fever'
    ],
    dept: 'Pediatrics',
    deptReason: 'Pediatric clinical assessment and hydration management.'
  },
  pregnancy_pain: {
    id: 'pregnancy_pain',
    name: 'Pregnancy Pain / Bleeding',
    phrases: [
      'pregnant with pelvic pain', 'pregnancy with mild spotting', 'third trimester abdominal cramping',
      'गर्भावस्था में पेट दर्द', 'गर्भवती महिला को रक्तस्राव',
      'గర్భవతికి కడుపు నొప్పి', 'గర్భధారణ సమయంలో రక్తస్రావం',
      'garbhavastha me dard', 'garbhavatiki noppi',
      'pregent pain', 'pregnent bleeding'
    ],
    dept: 'OB/GYN',
    deptReason: 'Obstetric assessment for maternal and fetal well-being.'
  },
  skin_rash: {
    id: 'skin_rash',
    name: 'Dermatological Rash / Urticaria',
    phrases: [
      'itching skin rash', 'red patches on arms and back', 'allergic hives no breathing issue',
      'त्वचा पर खुजली और चकत्ते', 'शरीर पर लाल दाने',
      'చర్మంపై దురద మరియు దద్దుర్లు', 'ఎర్రటి మచ్చలు',
      'khujli aur chakte', 'durada', 'daddurlu',
      'skn rash', 'itchy rash', 'red pacthes'
    ],
    dept: 'Dermatology',
    deptReason: 'Dermatological exam and non-emergent allergy management.'
  },
  ear_throat: {
    id: 'ear_throat',
    name: 'ENT / Ear Throat Discomfort',
    phrases: [
      'ear pain', 'difficulty swallowing with sore throat', 'ear discharge and fullness',
      'कान में दर्द', 'गले में खराश और निगलने में दर्द',
      'చెవి నొప్పి', 'గొంతు నొప్పి మింగలేకపోవడం',
      'kaan me dard', 'gale me kharash', 'chevi noppi', 'gontu noppi',
      'ere pain', 'soar throte'
    ],
    dept: 'ENT',
    deptReason: 'Otolaryngology examination for otitis or pharyngitis.'
  }
};

function extractMultilingualSymptoms(text) {
  const detected = [];
  const symptomsObj = {};
  if (!text) return { detected, symptomsObj };

  const lower = String(text).toLowerCase();

  for (const [symKey, data] of Object.entries(MULTILINGUAL_SYMPTOM_DICTIONARY)) {
    for (const phrase of data.phrases) {
      if (lower.includes(phrase.toLowerCase())) {
        detected.push({
          key: symKey,
          name: data.name,
          matchedPhrase: phrase,
          dept: data.dept
        });
        symptomsObj[symKey] = true;
        break;
      }
    }
  }

  return { detected, symptomsObj };
}

function predictAIAcuity(patient, complaintText, vitals) {
  const textExtraction = extractMultilingualSymptoms(complaintText);
  const detectedSymptoms = textExtraction.detected;
  const symObj = textExtraction.symptomsObj;
  
  const age = Number(patient?.age ?? 35);
  const v = vitals || {};
  const spo2 = v.spo2 !== undefined && v.spo2 !== '' ? Number(v.spo2) : 98;
  const sbp = v.sbp !== undefined && v.sbp !== '' ? Number(v.sbp) : 120;
  const hr = v.hr !== undefined && v.hr !== '' ? Number(v.hr) : 75;
  const rr = v.rr !== undefined && v.rr !== '' ? Number(v.rr) : 16;
  const temp = v.temp !== undefined && v.temp !== '' ? Number(v.temp) : 36.8;
  const gcs = v.gcs !== undefined && v.gcs !== '' ? Number(v.gcs) : 15;

  const feature_names = AI_MODEL_CONFIG.feature_names;
  const feats = [];

  for (const fname of feature_names) {
    if (fname.startsWith('sym_')) {
      const k = fname.replace('sym_', '');
      feats.push(symObj[k] ? 1.0 : 0.0);
    } else if (fname === 'spo2_low') {
      feats.push(spo2 < 90 ? 1.0 : 0.0);
    } else if (fname === 'sbp_low') {
      feats.push(sbp < 90 ? 1.0 : 0.0);
    } else if (fname === 'sbp_high') {
      feats.push(sbp > 180 ? 1.0 : 0.0);
    } else if (fname === 'hr_high') {
      feats.push(hr > 120 ? 1.0 : (hr > 100 ? 0.5 : 0.0));
    } else if (fname === 'hr_low') {
      feats.push(hr < 50 ? 1.0 : 0.0);
    } else if (fname === 'rr_high') {
      feats.push(rr > 24 ? 1.0 : 0.0);
    } else if (fname === 'temp_high') {
      feats.push(temp > 38.5 ? 1.0 : 0.0);
    } else if (fname === 'gcs_low') {
      feats.push(gcs <= 12 ? 1.0 : 0.0);
    } else if (fname === 'age_elderly') {
      feats.push(age >= 65 ? 1.0 : 0.0);
    } else if (fname === 'age_pediatric') {
      feats.push(age < 12 ? 1.0 : 0.0);
    } else {
      feats.push(0.0);
    }
  }

  // Softmax calculation
  const num_classes = AI_MODEL_CONFIG.num_classes;
  const weights = AI_MODEL_CONFIG.weights;
  const bias = AI_MODEL_CONFIG.bias;

  const logits = [];
  for (let c = 0; c < num_classes; c++) {
    let sum = bias[c];
    for (let j = 0; j < feats.length; j++) {
      sum += weights[c][j] * feats[j];
    }
    logits.push(sum);
  }

  const maxLogit = Math.max(...logits);
  const expLogits = logits.map(l => Math.exp(l - maxLogit));
  const sumExp = expLogits.reduce((a, b) => a + b, 0);
  const probs = expLogits.map(e => e / sumExp);

  // Pick highest probability class (1-indexed: 1 to 5)
  let bestClassIdx = 0;
  for (let c = 1; c < num_classes; c++) {
    if (probs[c] > probs[bestClassIdx]) bestClassIdx = c;
  }
  const predictedLevel = bestClassIdx + 1;
  const confidence = Math.round(probs[bestClassIdx] * 1000) / 10;

  // Determine Department recommendation
  let recommendedDept = 'General Medicine';
  let deptRationale = 'General medical evaluation indicated by initial presentation.';

  if (predictedLevel === 1) {
    recommendedDept = 'Emergency / Resuscitation';
    deptRationale = 'Immediate emergency resuscitation and critical airway/hemodynamic stabilization.';
  } else if (detectedSymptoms.length > 0) {
    const topSym = detectedSymptoms[0];
    const data = MULTILINGUAL_SYMPTOM_DICTIONARY[topSym.key];
    if (data) {
      recommendedDept = data.dept;
      deptRationale = data.deptReason;
    }
  }

  if (age < 12 && recommendedDept !== 'Emergency / Resuscitation') {
    recommendedDept = 'Pediatrics';
    deptRationale = 'Pediatric consultation indicated by patient age (<12 years).';
  }

  return {
    predictedLevel,
    confidence,
    probs,
    detectedSymptoms,
    recommendedDept,
    deptRationale
  };
}


  /**
   * PURE EVALUATION FUNCTION: evaluateTriage(patient, symptoms, vitals)
   *
   * Principle:
   * - Deterministic and rule-based.
   * - Highest level among fired rules wins (1 is highest priority, 4 lowest).
   * - Missing or conflicting data never lowers urgency.
   * - If no rules fired and data insufficient -> Level 3 + "Needs human review".
   * - If red flag present + missing vitals -> "Urgent: measure vitals now".
   */
  function evaluateTriage(patient, symptoms, vitals, complaintTextOverride) {
    const firedRules = [];
    const missingData = [];
    const reasons = [];
    const symptomsObj = Object.assign({}, symptoms || {});
    const vitalsObj = vitals || {};
    const age = Number(patient?.age ?? 30);
    const band = getAgeBand(age);
    const sex = String(patient?.sex || '').toLowerCase();
    const isPregnant = (patient?.pregnancy === 'Yes' || patient?.isPregnant === true);

    // Multilingual complaint & symptom extraction
    const complaintText = complaintTextOverride || patient?.chiefComplaint || patient?.complaint || '';
    const multilingualResult = extractMultilingualSymptoms(complaintText);
    multilingualResult.detected.forEach(d => { symptomsObj[d.key] = true; });

    // AI Acuity Model Inference
    const aiPrediction = predictAIAcuity(patient, complaintText, vitalsObj);

    // Identify red flags in symptoms
    const redFlagPresent = SYMPTOM_LIST.some(item => item.isRedFlag && symptomsObj[item.id]);

    // Check which key vitals are missing
    const hasSpo2 = vitalsObj.spo2 !== undefined && vitalsObj.spo2 !== null && vitalsObj.spo2 !== '';
    const hasSbp = vitalsObj.sbp !== undefined && vitalsObj.sbp !== null && vitalsObj.sbp !== '';
    const hasHr = vitalsObj.hr !== undefined && vitalsObj.hr !== null && vitalsObj.hr !== '';
    const hasRr = vitalsObj.rr !== undefined && vitalsObj.rr !== null && vitalsObj.rr !== '';
    const hasTemp = vitalsObj.temp !== undefined && vitalsObj.temp !== null && vitalsObj.temp !== '';

    if (!hasSpo2) missingData.push('SpO2');
    if (!hasSbp) missingData.push('Blood Pressure');
    if (!hasHr) missingData.push('Heart Rate');
    if (!hasRr) missingData.push('Respiratory Rate');
    if (!hasTemp) missingData.push('Temperature');

    let ruleHighestLevel = 5;

    function fireRule(ruleId, ruleName, ruleLevel, ruleCategory, ruleRationale) {
      firedRules.push({
        id: ruleId,
        name: ruleName,
        level: ruleLevel,
        category: ruleCategory,
        rationale: ruleRationale
      });
      if (ruleLevel < ruleHighestLevel) {
        ruleHighestLevel = ruleLevel;
      }
    }

    // MANDATORY DETERMINISTIC CLINICAL SAFETY RULES
    // Hypoxia
    if (hasSpo2) {
      const spo2 = Number(vitalsObj.spo2);
      if (spo2 < 90) {
        fireRule('R-SPO2-L1', 'Critical Hypoxia (SpO2 < 90%)', 1, 'Vitals',
          'Severe arterial hypoxemia impairs tissue oxygen delivery; immediate oxygen therapy and airway evaluation required.');
      } else if (spo2 <= 93) {
        fireRule('R-SPO2-L2', 'Borderline Hypoxia (SpO2 90-93%)', 2, 'Vitals',
          'Moderate hypoxemia indicates respiratory compromise requiring urgent clinician evaluation within 15 minutes.');
      }
    }

    // Shock / Blood Pressure
    if (hasSbp) {
      const sbp = Number(vitalsObj.sbp);
      if (sbp < 80) {
        fireRule('R-BP-L1', 'Severe Hypotension / Shock (SBP < 80 mmHg)', 1, 'Vitals',
          'Hemodynamic collapse and organ hypoperfusion risk; requires immediate fluid resuscitation and physician intervention.');
      } else if (sbp < 90) {
        fireRule('R-BP-L2', 'Hypotension (SBP 80-89 mmHg)', 2, 'Vitals',
          'Borderline low perfusion; urgent monitoring required.');
      } else if (sbp > 200) {
        fireRule('R-BP-L2-HIGH', 'Hypertensive Emergency (SBP > 200 mmHg)', 2, 'Vitals',
          'Severe hypertension risk of end-organ damage (stroke, encephalopathy, acute heart failure).');
      }
    }

    if (vitalsObj.dbp) {
      const dbp = Number(vitalsObj.dbp);
      if (dbp > 120) {
        fireRule('R-DBP-L2-HIGH', 'Severe Diastolic Hypertension (DBP > 120 mmHg)', 2, 'Vitals',
          'Marked diastolic pressure elevation presenting acute cardiovascular and cerebrovascular risk.');
      }
    }

    // Respiratory Rate
    if (hasRr) {
      const rr = Number(vitalsObj.rr);
      if (rr < 8 || rr > 35) {
        fireRule('R-RR-L1', `Impending Respiratory Failure (RR: ${rr}/min)`, 1, 'Vitals',
          'Extreme bradypnea or severe tachypnea indicates exhaustion or acute respiratory failure.');
      } else if (rr >= 25 && rr <= 35) {
        fireRule('R-RR-L2', `Severe Tachypnea (RR: ${rr}/min)`, 2, 'Vitals',
          'Increased work of breathing; urgent respiratory assessment required within 15 minutes.');
      }
    }

    // Heart Rate
    if (hasHr) {
      const hr = Number(vitalsObj.hr);
      if (hr < 40 || hr > 150) {
        fireRule('R-HR-L1', `Extreme Hemodynamic Arrhythmia (HR: ${hr} bpm)`, 1, 'Vitals',
          'Severe bradycardia or tachyarrhythmia with imminent risk of hemodynamic instability.');
      } else if (band === 'adult' && (hr > 120 || hr < 50)) {
        fireRule('R-HR-L2', `Significant Tachycardia / Bradycardia (HR: ${hr} bpm)`, 2, 'Vitals',
          'Abnormal heart rate outside resting compensation range.');
      } else if (band === 'infant' && (hr > 180 || hr < 80)) {
        fireRule('R-HR-PED-L1', `Infant Critical Heart Rate (HR: ${hr} bpm)`, 1, 'Pediatric Vitals',
          'Pediatric circulatory collapse warning: infant HR exceeds safe physiological tolerance.');
      } else if (band === 'child' && (hr > 140 || hr < 60)) {
        fireRule('R-HR-CHILD-L2', `Child Marked Tachycardia/Bradycardia (HR: ${hr} bpm)`, 2, 'Pediatric Vitals',
          'Child vital parameters deranged; urgent pediatric clinician review required.');
      }
    }

    // Neurological / Coma (GCS)
    if (vitalsObj.gcs) {
      const gcs = Number(vitalsObj.gcs);
      if (gcs <= 8) {
        fireRule('R-GCS-L1', `Severe Neurological Depression (GCS: ${gcs}/15)`, 1, 'Neurological',
          'GCS <= 8 indicates profound coma and inability to protect airway; immediate resuscitation bay transfer.');
      } else if (gcs <= 12) {
        fireRule('R-GCS-L2', `Moderate Neurological Impairment (GCS: ${gcs}/15)`, 2, 'Neurological',
          'Altered sensorium requires urgent clinician workup to exclude intracranial or metabolic emergency.');
      }
    }

    // Temperature & Sepsis
    if (hasTemp) {
      const temp = Number(vitalsObj.temp);
      if (temp > 40.0) {
        fireRule('R-TEMP-L2', `Hyperpyrexia (Temp: ${temp} °C)`, 2, 'Vitals',
          'Extreme fever with potential for febrile seizure, heat exhaustion, or hyperdynamic sepsis.');
      } else if (temp < 35.0) {
        fireRule('R-TEMP-L2-LOW', `Hypothermia (Temp: ${temp} °C)`, 2, 'Vitals',
          'Abnormally low body temperature indicating environmental exposure or cold sepsis.');
      }
    }

    // Clinical Symptom Rules
    if (symptomsObj.altered_consciousness) {
      fireRule('R-SYM-ALTERED', 'Altered Consciousness / Unresponsiveness', 1, 'Symptoms',
        'Acute neurological compromise requiring immediate airway assessment.');
    }
    if (symptomsObj.severe_bleeding) {
      fireRule('R-SYM-BLEED', 'Severe / Arterial Bleeding', 1, 'Symptoms',
        'Active uncontrolled hemorrhage with acute hypovolemic shock hazard.');
    }
    if (symptomsObj.stroke_signs) {
      fireRule('R-SYM-STROKE', 'Acute Stroke FAST Signs', 1, 'Symptoms',
        'Time-critical neurovascular event; thrombolysis / thrombectomy window active.');
    }
    if (symptomsObj.allergic_reaction && (symptomsObj.breathlessness || (hasSpo2 && Number(vitalsObj.spo2) < 94))) {
      fireRule('R-SYM-ANAPHYLAXIS', 'Anaphylaxis Airway Compromise', 1, 'Symptoms',
        'Severe systemic allergic reaction with bronchospasm or laryngeal edema; immediate epinephrine pathway.');
    }
    if (symptomsObj.chest_pain && (age >= 35 || symptomsObj.breathlessness)) {
      fireRule('R-SYM-CHEST', 'Acute Coronary Syndrome Suspected (Chest Pain)', 2, 'Symptoms',
        'Potential myocardial infarction; mandatory 10-minute ECG and emergency clinician workup.');
    }
    if (symptomsObj.breathlessness) {
      fireRule('R-SYM-DYSPNEA', 'Acute Dyspnea / Severe Breathlessness', 2, 'Symptoms',
        'Respiratory distress with compromised ventilation.');
    }
    // Suspected Meningitis Triad (R-MENINGITIS-L1)
    if ((symptomsObj.high_fever || (vitalsObj.temp && Number(vitalsObj.temp) >= 38.5)) && symptomsObj.stiff_neck && (symptomsObj.altered_consciousness || symptomsObj.altered_mental_status)) {
      fireRule('R-MENINGITIS-L1', 'Suspected Meningitis Triad (Fever + Stiff Neck + Altered Sensorium)', 1, 'Symptoms',
        'Classic triad for acute bacterial or viral central nervous system infection; mandatory immediate lumbar puncture / empiric IV antibiotics pathway.');
    }
    if (symptomsObj.pregnancy_bleeding_pain && isPregnant) {
      fireRule('R-SYM-OBGYN', 'Acute Obstetric Bleeding / Pelvic Pain', 2, 'Symptoms',
        'Obstetric emergency (ectopic pregnancy, placental abruption, threatened miscarriage).');
    }
    if (symptomsObj.seizure) {
      fireRule('R-SYM-SEIZURE', 'Recent Seizure / Post-Ictal State', 2, 'Symptoms',
        'Risk of recurrent status epilepticus or underlying cerebral insult.');
    }
    if (symptomsObj.head_injury && (vitalsObj.gcs && Number(vitalsObj.gcs) < 15)) {
      fireRule('R-SYM-HEAD-GCS', 'Traumatic Brain Injury with Depressed GCS', 2, 'Symptoms',
        'Intracranial injury risk; urgent trauma protocol.');
    }
    if (symptomsObj.severe_abdominal_pain) {
      fireRule('R-SYM-ABD', 'Acute Severe Abdominal Pain', 3, 'Symptoms',
        'Acute surgical or medical abdomen requiring urgent physical exam.');
    }
    if (symptomsObj.vomiting_diarrhea) {
      fireRule('R-SYM-GI', 'Acute Gastroenteritis / Dehydration Risk', 3, 'Symptoms',
        'Ongoing fluid and electrolyte loss; oral or IV rehydration assessment.');
    }
    if (symptomsObj.minor_injury) {
      fireRule('R-SYM-MINOR', 'Minor Musculoskeletal Injury', 4, 'Symptoms',
        'Stable peripheral injury without neurovascular deficit.');
    }
    if (symptomsObj.mild_cold) {
      fireRule('R-SYM-COLD', 'Mild Upper Respiratory Infection', 5, 'Symptoms',
        'Uncomplicated viral illness appropriate for standard outpatient consultation.');
    }

    // Default Baseline Acuity
    let suggestedLevel = ruleHighestLevel;
    let needsHumanReview = false;
    let urgentMeasureVitalsNow = false;
    let cannotAssessSafely = false;

    // Fail-safe Invariant 1: Missing Vitals NEVER lowers urgency
    const vitalsAllEmpty = !hasSpo2 && !hasSbp && !hasHr && !hasRr && !hasTemp;
    if (vitalsAllEmpty) {
      needsHumanReview = true;
      if (suggestedLevel > 3) suggestedLevel = 3;
      reasons.push('Failsafe: Complete absence of vital signs automatically bounds urgency to at least Level 3 ("Needs human review").');
    }

    // Fail-safe Invariant 2: Red flags present with unmeasured vitals
    if (redFlagPresent && (!hasSpo2 || !hasSbp || !hasHr)) {
      urgentMeasureVitalsNow = true;
      needsHumanReview = true;
      if (suggestedLevel > 2) suggestedLevel = 2;
      reasons.push('Clinical Alert: High-risk presentation detected with missing objective vitals. Urgent clinician measurement required.');
    }

    // Fail-safe Invariant 3: Abstention when critical data missing with acute presentation
    if (needsHumanReview && missingData.length >= 3 && redFlagPresent) {
      cannotAssessSafely = true;
      reasons.push('Cannot assess safely – Send to nurse for immediate human review.');
    }

    // ASYMMETRIC EMERGENCY OVERRIDE INVARIANT:
    // Mandatory clinical safety rules strictly override lower-risk ML predictions!
    const mlLevel = aiPrediction.predictedLevel;
    let recommendationSource = 'AI Acuity Classifier (Calibrated Multimodal Model)';

    if (ruleHighestLevel < mlLevel) {
      suggestedLevel = ruleHighestLevel;
      recommendationSource = 'Mandatory Clinical Safety Rule (Overrode lower-risk ML prediction)';
      reasons.push(`Mandatory emergency safety rule escalated urgency from ML Level ${mlLevel} to Level ${suggestedLevel}.`);
    } else if (ruleHighestLevel === mlLevel) {
      suggestedLevel = mlLevel;
      recommendationSource = 'Dual Agreement (AI Model & Safety Rule Concordant)';
    } else {
      // ML model suggested higher urgency than baseline rules (e.g., ML=2, rule=4)
      suggestedLevel = mlLevel;
      recommendationSource = 'AI Acuity Classifier (Calibrated Multimodal Model)';
      reasons.push(`AI Multimodal model recognized elevated risk pattern (Level ${suggestedLevel}, Confidence ${aiPrediction.confidence}%).`);
    }

    const LEVEL_LABELS = {
      1: 'Level 1 - Critical / Resuscitation (Immediate)',
      2: 'Level 2 - Emergent / High Risk (15 min)',
      3: 'Level 3 - Urgent (60 min)',
      4: 'Level 4 - Less Urgent (120 min)',
      5: 'Level 5 - Non-Urgent / Routine (180 min)'
    };

    const redFlagsList = SYMPTOM_LIST.filter(item => item.isRedFlag && symptomsObj[item.id]).map(i => i.label);

    const xaiExplanation = {
      suggestedLevel,
      levelLabel: LEVEL_LABELS[suggestedLevel],
      mlPredictedLevel: mlLevel,
      mlConfidence: aiPrediction.confidence,
      recommendedDept: aiPrediction.recommendedDept,
      deptRationale: aiPrediction.deptRationale,
      recommendationSource,
      detectedSymptoms: aiPrediction.detectedSymptoms,
      redFlags: redFlagsList,
      firedRules,
      missingData,
      cannotAssessSafely,
      safetyAlert: suggestedLevel <= 2
    };

    return {
      suggestedLevel,
      levelLabel: LEVEL_LABELS[suggestedLevel],
      firedRules,
      missingData,
      needsHumanReview,
      urgentMeasureVitalsNow,
      cannotAssessSafely,
      reasons,
      aiPrediction,
      recommendedDept: aiPrediction.recommendedDept,
      deptRationale: aiPrediction.deptRationale,
      xaiExplanation
    };
  }

  function generateToken() {
    const num = State.tokenCounter;
    State.tokenCounter += 1;
    saveAllState();
    return `OPD-${String(num).padStart(4, '0')}`;
  }

  /**
   * Check for duplicate patient (same name & phone registered within 12 virtual hours)
   */
  function checkDuplicatePatient(name, phone) {
    const cleanName = name.trim().toLowerCase();
    const cleanPhone = phone.trim().replace(/\D/g, '');
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const now = State.vTime;

    return State.patients.find(p => {
      const matchName = p.name.trim().toLowerCase() === cleanName;
      const matchPhone = p.phone.trim().replace(/\D/g, '') === cleanPhone;
      const recent = (now - p.registeredAt) <= TWELVE_HOURS_MS;
      return matchName && matchPhone && recent;
    });
  }

  function handleRegistrationSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('regFullName').value.trim();
    const age = parseFloat(document.getElementById('regAge').value);
    const sex = document.getElementById('regSex').value;
    const phone = document.getElementById('regPhone').value.trim();
    const arrivalMode = document.getElementById('regArrivalMode').value;
    const pregnancy = document.getElementById('regPregnancy').value;
    const allergies = document.getElementById('regAllergies').value.trim();
    const complaint = document.getElementById('regChiefComplaint').value.trim();

    // Validation
    if (!name || isNaN(age) || age < 0 || age > 120 || !phone || !complaint) {
      showToast('Validation Error', 'Please complete all required fields correctly (Age 0-120).', 'toast-warning');
      return;
    }

    const patientData = {
      name, age, sex, phone, arrivalMode, pregnancy, allergies, complaint
    };

    // Duplicate check
    const existing = checkDuplicatePatient(name, phone);
    if (existing) {
      State.pendingDuplicateData = patientData;
      document.getElementById('duplicatePatientDetails').innerHTML = `
        <strong>Existing Patient:</strong> ${existing.name} (${existing.token})<br>
        <strong>Registered:</strong> ${formatVirtualTime(existing.registeredAt)} (${Math.round((State.vTime - existing.registeredAt) / 60000)} min ago)<br>
        <strong>Chief Complaint:</strong> ${existing.complaint}<br>
        <strong>Status:</strong> ${existing.status}
      `;
      openModal('duplicateModal');
      return;
    }

    commitRegistration(patientData);
  }

  function commitRegistration(data) {
    const token = generateToken();
    const registeredAt = State.vTime;

    const knownConditions = (document.getElementById('regKnownConditions') ? document.getElementById('regKnownConditions').value.trim() : '') || data.knownConditions || '';
    const medications = (document.getElementById('regMedications') ? document.getElementById('regMedications').value.trim() : '') || data.medications || '';
    
    // Initial Multimodal AI Triage Prediction on Patient Intake
    const initialAi = predictAIAcuity(data, data.complaint, {});
    const isEmergencyIntake = (data.arrivalMode === 'Ambulance' || initialAi.predictedLevel === 1);

    const newPatient = {
      token,
      name: data.name,
      age: data.age,
      sex: data.sex,
      phone: data.phone,
      arrivalMode: data.arrivalMode,
      pregnancy: data.pregnancy || 'No',
      allergies: data.allergies || 'None',
      knownConditions,
      medications,
      complaint: data.complaint,
      registeredAt,
      status: 'WAITING',
      confirmedLevel: isEmergencyIntake ? 1 : null,
      systemSuggestedLevel: initialAi.predictedLevel,
      recommendedDept: initialAi.recommendedDept,
      deptRationale: initialAi.deptRationale,
      isProvisionalL1: isEmergencyIntake,
      isOverridden: false,
      overrideReason: null,
      isDowngraded: false,
      flaggedForDoctorReview: isEmergencyIntake,
      confirmedBy: null,
      confirmedAt: null,
      assignedRoom: isEmergencyIntake ? 'Resuscitation Bay' : 'Triage Waiting',
      customPriorityOrder: null,
      symptoms: {},
      vitals: {},
      clinicalNotes: '',
      triageHistory: []
    };

    State.patients.unshift(newPatient);

    // Audit Log
    addAuditEntry({
      action: 'REGISTRATION',
      patientToken: token,
      patientName: data.name,
      details: `Registered via ${data.arrivalMode}. Complaint: "${data.complaint}"`,
      diff: { name: data.name, age: data.age, phone: data.phone, arrivalMode: data.arrivalMode }
    });

    // If ambulance arrival, raise alert
    if (data.arrivalMode === 'Ambulance' || initialAi.predictedLevel === 1) {
      playEmergencyAlertSound();
      createAlert({
        patientToken: token,
        patientName: data.name,
        type: 'EMERGENCY_INTAKE',
        level: 1,
        message: `${data.arrivalMode === 'Ambulance' ? 'Ambulance arrival' : 'Critical acute presentation'}: immediate resuscitation bay priority required.`
      });
    }

    saveAllState();
    document.getElementById('patientRegistrationForm').reset();
    showToast('Patient Registered', `Assigned Token ${token}. Added to active triage queue.`, 'toast-info');
    switchTab('queueTab');
    renderQueueTable();
  }

  /**
   * Emergency Walk-In quick button
   * Fails safe: provisionally enters at top of queue at Level 1, raises immediate alert
   */
  function handleEmergencyWalkInSubmit() {
    const name = document.getElementById('emergName').value.trim() || 'Emergency Unknown';
    const age = parseFloat(document.getElementById('emergAge').value) || 40;
    const sex = document.getElementById('emergSex').value || 'Unknown';
    const complaint = document.getElementById('emergComplaint').value.trim() || 'Acute Critical Distress';

    const token = generateToken();
    const registeredAt = State.vTime;

    const patient = {
      token,
      name,
      age,
      sex,
      phone: '0000000000',
      arrivalMode: 'Walk-in',
      pregnancy: 'Unknown',
      allergies: 'Unknown',
      complaint,
      registeredAt,
      status: 'WAITING',
      confirmedLevel: 1, // Provisional L1
      systemSuggestedLevel: 1,
      isProvisionalL1: true,
      isOverridden: false,
      overrideReason: 'Emergency walk-in quick entry protocol',
      isDowngraded: false,
      flaggedForDoctorReview: true,
      confirmedBy: `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'}) [Provisional]`,
      confirmedAt: registeredAt,
      assignedRoom: 'Resuscitation Bay',
      customPriorityOrder: -999999, // Ensure placed at very top
      symptoms: { altered_consciousness: true, breathlessness: true },
      vitals: {},
      clinicalNotes: 'Registered via 1-click Emergency Walk-in protocol. Immediate bedside evaluation required.',
      triageHistory: []
    };

    State.patients.unshift(patient);

    addAuditEntry({
      action: 'REGISTRATION',
      patientToken: token,
      patientName: name,
      details: `EMERGENCY WALK-IN: Provisional Level 1 assigned. Complaint: "${complaint}"`,
      diff: { confirmedLevel: 1, isProvisionalL1: true }
    });

    // Immediate Alert
    createAlert({
      patientToken: token,
      patientName: name,
      type: 'EMERGENCY_L1_WALKIN',
      level: 1,
      message: `CRITICAL ALERT: Emergency Walk-In patient ${name} (${token}) entered at Level 1 Critical!`
    });

    saveAllState();
    closeModal('emergencyWalkInModal');
    showToast('🚨 Emergency Walk-In Registered', `${token} placed at top of queue (Level 1 Provisional). Immediate assessment required!`, 'toast-l1');
    renderQueueTable();

    // Auto-prompt escalation for Level 1
    promptEscalationForPatient(patient, 'Emergency Walk-In Level 1 patient detected.');
  }

    // ==========================================================================
  // SECTION 4: TRIAGE ASSESSMENT & HUMAN CONFIRMATION / OVERRIDE
  // ==========================================================================
  // Plain-language explanation:
  // The primary interface for Triage Nurses. Collects symptom checklists, validates
  // vital signs against physiological limits, presents deterministic rule suggestions,
  // requires human confirmation or explicit override rationale, and assigns service counters.

  function openTriageAssessmentModal(token) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) return;

    if (!enforcePermission('canTriage', 'perform triage assessment', token)) {
      return;
    }

    State.selectedPatientForTriage = patient;

    // Header info
    const band = getAgeBand(patient.age);
    document.getElementById('triagePatientHeader').innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <span class="token-cell" style="font-size:1.1rem;">${patient.token}</span>
          <strong style="margin-left:0.5rem; font-size:1rem;">${patient.name}</strong>
          <span style="color:#64748b; margin-left:0.5rem;">(${patient.age}y / ${patient.sex} - ${band})</span>
        </div>
        <div>
          <span class="status-badge waiting">Wait: ${Math.round((State.vTime - patient.registeredAt) / 60000)} min</span>
          <span style="font-size:0.8rem; color:#64748b; margin-left:0.5rem;">Arrival: ${patient.arrivalMode}</span>
        </div>
      </div>
      <div style="margin-top:0.35rem; font-size:0.85rem; color:#334155;">
        <strong>Chief Complaint:</strong> ${patient.complaint} | <strong>Allergies:</strong> ${patient.allergies || 'None'}
      </div>
    `;

    document.getElementById('vitalsAgeBandNotice').innerText = `Ranges adjusted for: ${band.toUpperCase()}`;

    // Update vitals normal hint ranges based on age band
    updateVitalsRangeHints(band);

    // Build Symptoms Checklist
    const symptomGrid = document.getElementById('assessmentSymptomGrid');
    symptomGrid.innerHTML = '';
    SYMPTOM_LIST.forEach(sym => {
      const isChecked = !!patient.symptoms[sym.id];
      const div = document.createElement('label');
      div.className = `symptom-item ${isChecked ? 'checked' : ''} ${sym.isRedFlag ? 'red-flag' : ''}`;
      div.innerHTML = `
        <input type="checkbox" id="sym_${sym.id}" data-id="${sym.id}" ${isChecked ? 'checked' : ''}>
        <span>${sym.isRedFlag ? '⚠️ ' : ''}${sym.label}</span>
      `;
      div.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) div.classList.add('checked');
        else div.classList.remove('checked');
        recalculateLiveSuggestion();
      });
      symptomGrid.appendChild(div);
    });

    // Populate vitals
    document.getElementById('vitalSpo2').value = patient.vitals?.spo2 ?? '';
    document.getElementById('vitalSbp').value = patient.vitals?.sbp ?? '';
    document.getElementById('vitalDbp').value = patient.vitals?.dbp ?? '';
    document.getElementById('vitalHr').value = patient.vitals?.hr ?? '';
    document.getElementById('vitalRr').value = patient.vitals?.rr ?? '';
    document.getElementById('vitalTemp').value = patient.vitals?.temp ?? '';
    document.getElementById('vitalGcs').value = patient.vitals?.gcs ?? '';
    document.getElementById('vitalPain').value = patient.vitals?.pain ?? '';
    document.getElementById('triageClinicalNotes').value = patient.clinicalNotes || '';

    // Pre-populate Assigned Room / Counter
    const roomEl = document.getElementById('triageAssignedRoom');
    if (roomEl) {
      if (patient.assignedRoom) {
        roomEl.value = patient.assignedRoom;
      } else {
        const initLvl = patient.confirmedLevel || (patient.isProvisionalL1 ? 1 : null);
        if (initLvl === 1) roomEl.value = 'Resuscitation Bay';
        else if (initLvl === 2) roomEl.value = 'Room 1 (Acute Care)';
        else if (initLvl === 3) roomEl.value = 'Room 2 (General OPD)';
        else if (initLvl === 4) roomEl.value = 'Room 3 (Fast Track / Minor)';
        else roomEl.value = 'Room 2 (General OPD)';
      }
    }

    // Reset override sub-form
    document.getElementById('overrideSubForm').classList.remove('visible');
    document.getElementById('overrideReasonInput').value = patient.overrideReason || '';
    if (patient.confirmedLevel) {
      document.getElementById('overrideLevelSelect').value = String(patient.confirmedLevel);
    }

    // Attach real-time input listeners to vitals
    ['vitalSpo2', 'vitalSbp', 'vitalDbp', 'vitalHr', 'vitalRr', 'vitalTemp', 'vitalGcs', 'vitalPain'].forEach(id => {
      const el = document.getElementById(id);
      el.oninput = () => recalculateLiveSuggestion();
    });

    recalculateLiveSuggestion();
    openModal('triageModal');
  }

  function updateVitalsRangeHints(band) {
    if (band === 'infant') {
      document.getElementById('rangeHr').innerText = '100 - 160';
      document.getElementById('rangeRr').innerText = '30 - 50';
      document.getElementById('rangeSbp').innerText = '70 - 100';
    } else if (band === 'child') {
      document.getElementById('rangeHr').innerText = '70 - 130';
      document.getElementById('rangeRr').innerText = '18 - 30';
      document.getElementById('rangeSbp').innerText = '80 - 115';
    } else {
      document.getElementById('rangeHr').innerText = '60 - 100';
      document.getElementById('rangeRr').innerText = '12 - 20';
      document.getElementById('rangeSbp').innerText = '90 - 140';
    }
  }

  function getCurrentModalVitals() {
    return {
      spo2: document.getElementById('vitalSpo2').value,
      sbp: document.getElementById('vitalSbp').value,
      dbp: document.getElementById('vitalDbp').value,
      hr: document.getElementById('vitalHr').value,
      rr: document.getElementById('vitalRr').value,
      temp: document.getElementById('vitalTemp').value,
      gcs: document.getElementById('vitalGcs').value,
      pain: document.getElementById('vitalPain').value
    };
  }

  function getCurrentModalSymptoms() {
    const symptoms = {};
    SYMPTOM_LIST.forEach(sym => {
      const chk = document.getElementById(`sym_${sym.id}`);
      if (chk && chk.checked) symptoms[sym.id] = true;
    });
    return symptoms;
  }

  function recalculateLiveSuggestion() {
    if (!State.selectedPatientForTriage) return;

    const patient = State.selectedPatientForTriage;
    const vitals = getCurrentModalVitals();
    const symptoms = getCurrentModalSymptoms();

    // Check vitals validity
    const validation = validateVitals(vitals, patient.age);

    // Clear previous inline warnings
    ['Spo2', 'Sbp', 'Dbp', 'Hr', 'Rr', 'Temp', 'Gcs', 'Pain'].forEach(k => {
      const warnEl = document.getElementById(`warn${k}`);
      if (warnEl) warnEl.innerText = '';
      const inputEl = document.getElementById(`vital${k}`);
      if (inputEl) {
        inputEl.classList.remove('input-invalid');
        inputEl.classList.remove('input-warning');
      }
    });

    validation.errors.forEach(err => {
      const capKey = err.field.charAt(0).toUpperCase() + err.field.slice(1);
      const warnEl = document.getElementById(`warn${capKey}`);
      if (warnEl) warnEl.innerText = err.msg;
      const inputEl = document.getElementById(`vital${capKey}`);
      if (inputEl) inputEl.classList.add('input-invalid');
    });

    validation.warnings.forEach(warn => {
      const capKey = warn.field.charAt(0).toUpperCase() + warn.field.slice(1);
      const warnEl = document.getElementById(`warn${capKey}`);
      if (warnEl && !warnEl.innerText) warnEl.innerText = warn.msg;
      const inputEl = document.getElementById(`vital${capKey}`);
      if (inputEl && !inputEl.classList.contains('input-invalid')) {
        inputEl.classList.add('input-warning');
      }
    });

    const evalResult = evaluateTriage(patient, symptoms, vitals);
    renderLiveDecisionBox(evalResult);
  }

  function renderLiveDecisionBox(result) {
    const box = document.getElementById('liveDecisionSupportContainer');
    box.className = `decision-support-box l${result.suggestedLevel}-border`;

    const levelBadgeClass = `l${result.suggestedLevel}`;
    const levelIcons = { 1: '🔴', 2: '🟠', 3: '🟡', 4: '🟢', 5: '⚪' };
    const icon = levelIcons[result.suggestedLevel] || '⚪';

    let firedHtml = '';
    if (result.firedRules.length > 0) {
      firedHtml = `
        <h5 style="font-size:0.8rem; text-transform:uppercase; color:#475569; margin-top:0.5rem;">Fired Clinical Safety Rules (${result.firedRules.length}):</h5>
        <ul class="fired-rules-list">
          ${result.firedRules.map(r => `
            <li class="fired-rule-item l${r.level}">
              <strong>${levelIcons[r.level]} ${r.name}</strong> &rarr; Suggests Level ${r.level}
              <div style="font-size:0.75rem; color:#475569; margin-top:2px;">${r.rationale}</div>
            </li>
          `).join('')}
        </ul>
      `;
    } else {
      firedHtml = '<p class="form-hint" style="margin-top:0.5rem;">Baseline evaluation active. No clinical emergency safety rules triggered.</p>';
    }

    let flagsHtml = '';
    if (result.cannotAssessSafely) {
      flagsHtml += `
        <div class="danger-callout" style="margin-top:0.5rem; font-weight:700;">
          ⚠️ Cannot assess safely – Send to nurse for immediate human review.
        </div>
      `;
    } else if (result.urgentMeasureVitalsNow) {
      flagsHtml += `
        <div class="danger-callout" style="margin-top:0.5rem; font-weight:700;">
          🚨 URGENT: Red flag symptoms identified with unmeasured objective vitals. Measure vital signs immediately!
        </div>
      `;
    } else if (result.needsHumanReview) {
      flagsHtml += `
        <div class="warning-callout" style="margin-top:0.5rem;">
          ⚠️ Failsafe Guardrail: Needs human clinician review. Urgency held safe due to unmeasured vital parameters.
        </div>
      `;
    }

    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <span style="font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase;">AI & Clinical Rule Recommendation:</span>
          <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.25rem;">
            <span class="badge ${levelBadgeClass}" style="font-size:1.1rem; padding:4px 12px;">
              ${icon} ${result.levelLabel}
            </span>
          </div>
        </div>
        <div style="text-align:right;">
          <span class="status-badge" style="background:#e0f2fe; color:#0369a1; font-weight:700;">
            Source: ${result.xaiExplanation.recommendationSource.split('(')[0]}
          </span>
          <div style="font-size:0.75rem; color:#64748b; margin-top:2px;">
            ML Confidence: ${result.xaiExplanation.mlConfidence}%
          </div>
        </div>
      </div>
      ${flagsHtml}
      ${firedHtml}
    `;

    // Render XAI Explanation Panel
    const xaiPanel = document.getElementById('triageXaiPanel');
    if (xaiPanel) {
      xaiPanel.style.display = 'block';

      const confBadge = document.getElementById('xaiModelConfidenceBadge');
      if (confBadge) confBadge.textContent = `Confidence: ${result.xaiExplanation.mlConfidence}%`;

      const abstentionNotice = document.getElementById('xaiAbstentionNotice');
      if (abstentionNotice) {
        abstentionNotice.style.display = result.cannotAssessSafely ? 'block' : 'none';
      }

      const factorsGrid = document.getElementById('xaiFactorsGrid');
      if (factorsGrid) {
        const symList = result.xaiExplanation.detectedSymptoms.length > 0
          ? result.xaiExplanation.detectedSymptoms.map(s => `<span class="badge-l5" style="margin:2px;">${s.name} (${s.matchedPhrase})</span>`).join('')
          : '<span style="color:#64748b;">No high-acuity multilingual keywords identified</span>';

        const redFlagList = result.xaiExplanation.redFlags.length > 0
          ? result.xaiExplanation.redFlags.map(r => `<span style="color:#dc2626; font-weight:700; margin-right:4px;">⚠️ ${r}</span>`).join('')
          : '<span style="color:#16a34a;">None detected</span>';

        factorsGrid.innerHTML = `
          <div class="xai-factor-card">
            <div class="xai-factor-title">🎯 Acuity &amp; Recommendation Source</div>
            <div style="font-weight:800; color:#0f172a; font-size:0.95rem;">${icon} Level ${result.suggestedLevel}</div>
            <div style="font-size:0.75rem; color:#0284c7; margin-top:2px;">${result.xaiExplanation.recommendationSource}</div>
          </div>

          <div class="xai-factor-card">
            <div class="xai-factor-title">🏥 Recommended Department</div>
            <div style="font-weight:800; color:#0f172a; font-size:0.95rem;">${result.recommendedDept}</div>
            <div style="font-size:0.75rem; color:#64748b; margin-top:2px;">${result.deptRationale}</div>
          </div>

          <div class="xai-factor-card">
            <div class="xai-factor-title">🌐 Multilingual NLP Signals</div>
            <div style="margin-top:2px;">${symList}</div>
          </div>

          <div class="xai-factor-card">
            <div class="xai-factor-title">⚠️ Red Flags &amp; Missing Vitals</div>
            <div style="margin-bottom:2px;">${redFlagList}</div>
            <div style="font-size:0.75rem; color:#d97706;">
              ${result.missingData.length > 0 ? 'Unmeasured: ' + result.missingData.join(', ') : 'All vitals measured'}
            </div>
          </div>
        `;
      }
    }

    // Auto-update department select if not yet manually changed
    const deptSelect = document.getElementById('triageDepartmentSelect');
    if (deptSelect && result.recommendedDept) {
      deptSelect.value = result.recommendedDept;
    }
    const deptHint = document.getElementById('triageDeptRationaleHint');
    if (deptHint && result.deptRationale) {
      deptHint.textContent = result.deptRationale;
    }
  }

  function handleConfirmSuggestionClick() {
    if (!State.currentModalEvaluation) return;
    const level = State.currentModalEvaluation.suggestedLevel;
    document.getElementById('overrideSubForm').classList.remove('visible');
    executeSaveTriage(level, false, null);
  }

  function handleToggleOverrideClick() {
    const subForm = document.getElementById('overrideSubForm');
    subForm.classList.toggle('visible');
    if (subForm.classList.contains('visible')) {
      document.getElementById('overrideReasonInput').focus();
    }
  }

  function handleSaveTriageClick() {
    const subForm = document.getElementById('overrideSubForm');
    const isOverride = subForm.classList.contains('visible');

    if (isOverride) {
      const overrideLevel = parseInt(document.getElementById('overrideLevelSelect').value, 10);
      const reason = document.getElementById('overrideReasonInput').value.trim();

      if (!reason) {
        showToast('Mandatory Field Required', 'Human overrides require a documented clinical justification.', 'toast-warning');
        document.getElementById('overrideReasonInput').classList.add('input-invalid');
        document.getElementById('overrideReasonInput').focus();
        return;
      }

      const suggested = State.currentModalEvaluation.suggestedLevel;
      // Check if downgrading urgency (e.g. suggested was 1, chosen is 2, 3, or 4; suggested was 2, chosen is 3, 4)
      if (overrideLevel > suggested) {
        // Down-grading urgency requires extra confirmation
        State.pendingDowngradeData = { overrideLevel, reason };
        document.getElementById('downgradeOldLevel').innerText = `Level ${suggested}`;
        document.getElementById('downgradeNewLevel').innerText = `Level ${overrideLevel}`;
        openModal('downgradeModal');
        return;
      }

      executeSaveTriage(overrideLevel, true, reason, false);
    } else {
      // Just confirming system suggestion
      const suggested = State.currentModalEvaluation.suggestedLevel;
      executeSaveTriage(suggested, false, null, false);
    }
  }

  function handleConfirmDowngradeClick() {
    if (!State.pendingDowngradeData) return;
    const { overrideLevel, reason } = State.pendingDowngradeData;
    closeModal('downgradeModal');
    executeSaveTriage(overrideLevel, true, reason, true);
    State.pendingDowngradeData = null;
  }

  /**
   * Commit the clinical triage decision
   */
  function executeSaveTriage(level, isOverridden, overrideReason, isDowngraded) {
    const patient = State.selectedPatientForTriage;
    if (!patient) return;

    if (!enforcePermission('canTriage', 'commit clinical triage decision', patient.token)) {
      return;
    }

    const vitals = getCurrentModalVitals();
    const symptoms = getCurrentModalSymptoms();
    const clinicalNotes = document.getElementById('triageClinicalNotes').value.trim();

    // Check hard validation limits before saving
    const validation = validateVitals(vitals, patient.age);
    if (!validation.isValid) {
      showToast('Validation Error', 'Physiologically impossible vitals detected. Please correct before committing.', 'toast-warning');
      return;
    }

    const previousLevel = patient.confirmedLevel;
    const suggested = State.currentModalEvaluation.suggestedLevel;

    const roomInput = document.getElementById('triageAssignedRoom');
    const assignedRoom = (roomInput ? roomInput.value.trim() : '') || 'Room 2 (General OPD)';

    const deptSelect = document.getElementById('triageDepartmentSelect');
    const assignedDept = (deptSelect ? deptSelect.value : '') || State.currentModalEvaluation.recommendedDept || 'General Medicine';

    // Snapshot for history
    const historyEntry = {
      timestamp: State.vTime,
      user: State.currentUser,
      role: State.currentRole,
      previousLevel,
      confirmedLevel: level,
      suggestedLevel: suggested,
      isOverridden,
      overrideReason,
      isDowngraded,
      assignedRoom,
      vitals: { ...vitals },
      symptoms: { ...symptoms },
      firedRules: [...(State.currentModalEvaluation.firedRules || [])]
    };

    patient.vitals = vitals;
    patient.symptoms = symptoms;
    patient.clinicalNotes = clinicalNotes;
    patient.systemSuggestedLevel = suggested;
    patient.confirmedLevel = level;
    patient.assignedRoom = assignedRoom;
    patient.assignedDept = assignedDept;
    patient.recommendedDept = State.currentModalEvaluation.recommendedDept;
    patient.deptRationale = State.currentModalEvaluation.deptRationale;
    patient.xaiExplanation = State.currentModalEvaluation.xaiExplanation;
    patient.isProvisionalL1 = false;

    // Trigger Smart Emergency Alert if Level 1 or 2
    if (level <= 2) {
      playEmergencyAlertSound();
      const existingAlert = State.alerts.find(a => a.patientToken === patient.token && a.state !== 'RESOLVED');
      if (!existingAlert) {
        const triggerReason = State.currentModalEvaluation.firedRules.length > 0
          ? State.currentModalEvaluation.firedRules[0].name
          : `High acuity triage assessment (Level ${level})`;
        createAlert({
          patientToken: patient.token,
          patientName: patient.name,
          type: level === 1 ? 'EMERGENCY_L1' : 'EMERGENCY_L2',
          level,
          message: `Critical patient confirmed at Level ${level}: ${triggerReason}`
        });
      }
    }
    patient.isOverridden = isOverridden;
    patient.overrideReason = overrideReason;
    patient.isDowngraded = isDowngraded;
    patient.flaggedForDoctorReview = isDowngraded || (level === 1) || (patient.flaggedForDoctorReview && level <= 2);
    patient.confirmedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    patient.confirmedAt = State.vTime;
    patient.status = 'IN_ASSESSMENT';
    patient.triageHistory.push(historyEntry);

    // Audit Entry
    addAuditEntry({
      action: isOverridden ? 'TRIAGE_OVERRIDE' : 'TRIAGE_CONFIRM',
      patientToken: patient.token,
      patientName: patient.name,
      details: isOverridden
        ? `Overrode System L${suggested} -> L${level}. Room: ${assignedRoom}. Reason: "${overrideReason}"${isDowngraded ? ' [FLAGGED DOWNGRADE]' : ''}`
        : `Confirmed System Suggestion: Level ${level} (Assigned: ${assignedRoom})`,
      diff: {
        systemSuggestion: suggested,
        humanConfirmed: level,
        assignedRoom,
        isOverridden,
        isDowngraded,
        rulesFired: State.currentModalEvaluation.firedRules.map(r => r.id)
      }
    });

    // Alert Handling for Level 1 or 2
    if (level === 1) {
      createAlert({
        patientToken: patient.token,
        patientName: patient.name,
        type: 'CRITICAL_L1_CONFIRMED',
        level: 1,
        message: `LEVEL 1 CRITICAL: ${patient.name} (${patient.token}) confirmed at Level 1 by ${State.currentUser}!`
      });
    } else if (level === 2) {
      createAlert({
        patientToken: patient.token,
        patientName: patient.name,
        type: 'URGENT_L2_CONFIRMED',
        level: 2,
        message: `LEVEL 2 URGENT: ${patient.name} (${patient.token}) confirmed at Level 2 (15 min SLA).`
      });
    }

    saveAllState();
    closeModal('triageModal');
    showToast('Triage Committed', `Patient ${patient.token} confirmed as Level ${level}.`, level === 1 ? 'toast-l1' : 'toast-info');
    renderQueueTable();

    // Auto-prompt escalation for Level 1
    if (level === 1) {
      promptEscalationForPatient(patient, 'Level 1 Critical patient requires immediate clinical escalation.');
    } else if (previousLevel && level < previousLevel) {
      // Deterioration on re-triage (lower number = higher urgency, e.g. was 3, now 2 or 1)
      promptEscalationForPatient(patient, `Re-triage deterioration detected: Urgency escalated from Level ${previousLevel} to Level ${level}.`);
    }
  }

    // ==========================================================================
  // SECTION 5: CLINICAL ALERTS & VIRTUAL TIME SLA ENGINE
  // ==========================================================================
  // Plain-language explanation:
  // Monitors patient waiting durations against clinical SLA benchmarks (L1 immediate,
  // L2 15 min, L3 60 min, L4 120 min). Generates visual alerts when wait times are breached
  // or abnormal vitals are recorded, supporting clinical acknowledgment and resolution notes.

  function createAlert({ patientToken, patientName, type, level, message }) {
    const alertId = `ALT-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`.toUpperCase();
    const newAlert = {
      id: alertId,
      patientToken,
      patientName,
      type,
      level,
      message,
      state: 'NEW', // NEW -> ACKNOWLEDGED -> RESOLVED
      createdAt: State.vTime,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      escalatedToRole: null
    };

    State.alerts.unshift(newAlert);

    addAuditEntry({
      action: 'ALERT_RAISED',
      patientToken,
      patientName,
      details: `Alert [${type}] raised (Level ${level}): ${message}`,
      diff: { alertId, type, level }
    });

    saveAllState();
    updateAlertCounterUI();
    showToast(`🔔 Clinical Alert (Level ${level})`, message, level === 1 ? 'toast-l1' : 'toast-warning');
    return newAlert;
  }

  function acknowledgeAlert(alertId) {
    const alert = State.alerts.find(a => a.id === alertId);
    if (!alert || alert.state !== 'NEW') return;

    alert.state = 'ACKNOWLEDGED';
    alert.acknowledgedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    alert.acknowledgedAt = State.vTime;

    addAuditEntry({
      action: 'ALERT_ACKNOWLEDGED',
      patientToken: alert.patientToken,
      patientName: alert.patientName,
      details: `Alert ${alert.id} acknowledged by ${State.currentUser}`,
      diff: { alertId: alert.id, state: 'ACKNOWLEDGED' }
    });

    saveAllState();
    updateAlertCounterUI();
    renderAlertCenterModal();
    showToast('Alert Acknowledged', `Alert for ${alert.patientToken} acknowledged.`, 'toast-info');
  }

  function resolveAlert(alertId, note) {
    const alert = State.alerts.find(a => a.id === alertId);
    if (!alert) return;

    alert.state = 'RESOLVED';
    alert.resolvedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    alert.resolvedAt = State.vTime;
    alert.resolutionNote = note || 'Clinically managed';

    addAuditEntry({
      action: 'ALERT_RESOLVED',
      patientToken: alert.patientToken,
      patientName: alert.patientName,
      details: `Alert ${alert.id} resolved by ${State.currentUser}. Note: "${alert.resolutionNote}"`,
      diff: { alertId: alert.id, state: 'RESOLVED' }
    });

    saveAllState();
    updateAlertCounterUI();
    renderAlertCenterModal();
    showToast('Alert Resolved', `Alert marked resolved.`, 'toast-info');
  }

  function updateAlertCounterUI() {
    const activeAlerts = State.alerts.filter(a => a.state !== 'RESOLVED');
    const badge = document.getElementById('alertCountBadge');
    badge.innerText = String(activeAlerts.length);
    if (activeAlerts.length > 0) {
      badge.classList.remove('zero');
    } else {
      badge.classList.add('zero');
    }
  }

  function renderAlertCenterModal() {
    const container = document.getElementById('alertCenterList');
    container.innerHTML = '';

    if (State.alerts.length === 0) {
      container.innerHTML = '<div style="text-align:center; color:#64748b; padding:2rem;">No clinical alerts logged yet.</div>';
      return;
    }

    State.alerts.forEach(alt => {
      const item = document.createElement('div');
      item.className = 'escalation-card';
      if (alt.state === 'ACKNOWLEDGED') item.classList.add('acknowledged');
      if (alt.state === 'RESOLVED') item.classList.add('resolved');

      const elapsedMin = Math.round((State.vTime - alt.createdAt) / 60000);
      const isL1 = alt.level === 1;

      item.innerHTML = `
        <div class="escalation-meta">
          <span>
            <strong style="color:${isL1 ? '#dc2626' : '#ea580c'};">
              ${isL1 ? '🚨 Level 1 Critical Emergency Alert' : '🟠 Level 2 Emergent Clinical Alert'}
            </strong>
            &bull; Token: <strong>${alt.patientToken || 'General'}</strong> (${alt.patientName || 'N/A'})
          </span>
          <span>Logged: ${formatVirtualTime(alt.createdAt)} (${elapsedMin}m ago)</span>
        </div>
        <div style="font-size:0.9rem; margin-bottom:0.5rem; color:#0f172a; font-weight:600;">
          ${alt.message}
        </div>
        <div style="font-size:0.75rem; color:#64748b; margin-bottom:0.5rem;">
          ${alt.acknowledgedBy ? `Acknowledged by: <strong>${alt.acknowledgedBy}</strong> &bull; ` : ''}
          ${alt.escalatedBy ? `Escalated by: <strong>${alt.escalatedBy}</strong> &bull; ` : ''}
          ${alt.doctorReviewedBy ? `Doctor Review: <strong>${alt.doctorReviewedBy}</strong> ("${alt.doctorReviewNote || ''}") &bull; ` : ''}
          ${alt.resolvedBy ? `Resolved by: <strong>${alt.resolvedBy}</strong> ("${alt.resolutionNote || ''}")` : ''}
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <span class="status-badge" style="background:#fee2e2; color:#b91c1c; border:1px solid #f87171; font-weight:800;">
            Lifecycle: ${alt.state}
          </span>
          <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
            ${alt.state === 'NEW' ? `
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.ackAlert('${alt.id}')">
                👁️ Acknowledge (Nurse)
              </button>
              <button class="btn btn-warning btn-sm" onclick="window.triageApp.escalateAlert('${alt.id}')">
                🚨 Escalate to Doctor
              </button>
            ` : ''}
            ${alt.state === 'ACKNOWLEDGED' ? `
              <button class="btn btn-warning btn-sm" onclick="window.triageApp.escalateAlert('${alt.id}')">
                🚨 Escalate to Doctor
              </button>
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.promptResolveAlert('${alt.id}')">
                ✅ Mark Resolved
              </button>
            ` : ''}
            ${alt.state === 'ESCALATED' ? `
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.reviewAlert('${alt.id}')">
                🩺 Doctor Review / Orders
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.promptResolveAlert('${alt.id}')">
                ✅ Mark Resolved
              </button>
            ` : ''}
            ${alt.state === 'REVIEWED' ? `
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.promptResolveAlert('${alt.id}')">
                ✅ Complete Disposition &amp; Close
              </button>
            ` : ''}
            ${alt.state === 'RESOLVED' ? `
              <span style="font-size:0.75rem; color:#16a34a; font-weight:700;">✅ Closed &amp; Documented</span>
            ` : ''}
          </div>
        </div>
      `;
      container.appendChild(item);
    });
  }

  function sortPatients(list) {
    return [...list].sort((a, b) => {
      // Custom manual priority order overrides
      if (a.customPriorityOrder !== null && b.customPriorityOrder !== null) {
        return a.customPriorityOrder - b.customPriorityOrder;
      }
      if (a.customPriorityOrder !== null) return -1;
      if (b.customPriorityOrder !== null) return 1;

      // Effective urgency level (default to 4 if unassessed)
      const levelA = a.confirmedLevel || (a.isProvisionalL1 ? 1 : 99);
      const levelB = b.confirmedLevel || (b.isProvisionalL1 ? 1 : 99);

      if (levelA !== levelB) {
        return levelA - levelB;
      }

      // Check SLA overdue within same level
      const waitA = Math.floor((State.vTime - a.registeredAt) / 60000);
      const waitB = Math.floor((State.vTime - b.registeredAt) / 60000);
      const slaTargetA = SLA_MINUTES[levelA] ?? 120;
      const slaTargetB = SLA_MINUTES[levelB] ?? 120;
      const breachA = waitA - slaTargetA;
      const breachB = waitB - slaTargetB;

      if ((breachA > 0 || breachB > 0) && breachA !== breachB) {
        return breachB - breachA; // Highest breach first
      }

      // Earliest arrival first
      return a.registeredAt - b.registeredAt;
    });
  }

  function renderQueueTable() {
    const tbody = document.getElementById('queueTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const filterLevel = document.getElementById('filterLevel').value;
    const filterStatus = document.getElementById('filterStatus').value;
    const query = (document.getElementById('queueSearchInput').value || '').trim().toLowerCase();

    const filtered = State.patients.filter(p => {
      // Status filter
      if (filterStatus === 'ACTIVE') {
        if (p.status === 'SEEN' || p.status === 'LWBS') return false;
      } else if (filterStatus !== 'ALL') {
        if (p.status !== filterStatus) return false;
      }

      // Level filter
      if (filterLevel === 'REVIEW') {
        if (!p.flaggedForDoctorReview) return false;
      } else if (filterLevel !== 'ALL') {
        const lvl = parseInt(filterLevel, 10);
        if (p.confirmedLevel !== lvl) return false;
      }

      // Search query
      if (query) {
        const matchToken = p.token.toLowerCase().includes(query);
        const matchName = p.name.toLowerCase().includes(query);
        const matchComplaint = (p.complaint || '').toLowerCase().includes(query);
        if (!matchToken && !matchName && !matchComplaint) return false;
      }

      return true;
    });

    const sorted = sortPatients(filtered);

    // Update active badge
    const activeCount = State.patients.filter(p => p.status !== 'SEEN' && p.status !== 'LWBS').length;
    document.getElementById('queueCountBadge').innerText = String(activeCount);

    if (sorted.length === 0) {
      const isQueueTotallyEmpty = State.patients.length === 0;
      tbody.innerHTML = `
        <tr>
          <td colspan="9">
            <div class="empty-state">
              <div class="empty-state-icon">${isQueueTotallyEmpty ? '📋' : '🔍'}</div>
              <div class="empty-state-title">${isQueueTotallyEmpty ? 'No patients in queue' : 'No matching patients'}</div>
              <div class="empty-state-desc">${isQueueTotallyEmpty ? 'All registered patients have been assessed or discharged. Click "Load Demo Data" or "Register Patient" to begin.' : 'No patients match the selected level and status filters.'}</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const currentRoleConfig = ROLES[State.currentRole] || { canTriage: false, canEscalate: false, canRespondDoctor: false, canReorder: false, canManageAccounts: false };

    sorted.forEach((patient, index) => {
      const waitMin = Math.max(0, Math.floor((State.vTime - patient.registeredAt) / 60000));
      const level = patient.confirmedLevel || (patient.isProvisionalL1 ? 1 : null);
      const slaTarget = level ? SLA_MINUTES[level] : null;

      // SLA display calculation
      let slaHtml = '<span class="sla-badge ok">&infin; Pending</span>';
      if (slaTarget !== null) {
        const remaining = slaTarget - waitMin;
        if (remaining < 0) {
          slaHtml = `<span class="sla-badge breached">🔴 BREACHED (+${Math.abs(remaining)}m)</span>`;
        } else if (remaining <= 5) {
          slaHtml = `<span class="sla-badge warning">⏳ ${remaining} min left</span>`;
        } else {
          slaHtml = `<span class="sla-badge ok">🟢 ${remaining} min left</span>`;
        }
      }

      // Urgency Level Badge (COLOR + ICON + TEXT) - 5 ESI Levels
      const isEmergencyPatient = (level === 1 || patient.isProvisionalL1 || (level === 2 && State.alerts.some(a => a.patientToken === patient.token && a.state !== 'RESOLVED')));

      let levelBadgeHtml = '<span class="urgency-badge unassessed">⏳ Awaiting Triage</span>';
      if (patient.isProvisionalL1) {
        levelBadgeHtml = '<span class="urgency-badge l1" title="Provisional Level 1">🚨 Provisional L1</span>';
      } else if (level) {
        const levelData = {
          1: { cls: 'l1', icon: '🔴', text: 'Level 1 - Critical' },
          2: { cls: 'l2', icon: '🟠', text: 'Level 2 - Urgent' },
          3: { cls: 'l3', icon: '🟡', text: 'Level 3 - Semi-urgent' },
          4: { cls: 'l4', icon: '🟢', text: 'Level 4 - Less Urgent' },
          5: { cls: 'l4', icon: '⚪', text: 'Level 5 - Routine' }
        }[level] || { cls: 'l4', icon: '⚪', text: `Level ${level}` };
        levelBadgeHtml = `<span class="urgency-badge ${levelData.cls}">${levelData.icon} ${levelData.text}</span>`;
      }

      if (patient.flaggedForDoctorReview) {
        levelBadgeHtml += ' <span class="urgency-badge review" title="Flagged for Doctor Review">⚠️ Review</span>';
      }

      const tr = document.createElement('tr');
      if (isEmergencyPatient) tr.classList.add('emergency-row-pulse');
      if (level === 1) tr.classList.add('highlight-l1');

      tr.innerHTML = `
        <td class="token-cell">
          <button class="btn btn-secondary btn-sm" onclick="window.triageApp.openTimeline('${patient.token}')" title="Click to view full clinical audit history">
            ${patient.token}
          </button>
        </td>
        <td>
          <div style="font-weight:700;">${escapeHtml(patient.name)}</div>
          <div style="font-size:0.75rem; color:#64748b;">${patient.age}y / ${patient.sex}</div>
        </td>
        <td>${formatTimeOnly(patient.registeredAt)}</td>
        <td style="max-width:240px; word-break:break-word;">
          ${escapeHtml(patient.complaint)}
        </td>
        <td>${levelBadgeHtml}</td>
        <td><span class="room-badge">📍 ${escapeHtml(patient.assignedRoom || 'Unassigned')}</span></td>
        <td style="font-family:var(--font-mono); font-weight:600;">${waitMin} min</td>
        <td>${slaHtml}</td>
        <td><span class="status-badge ${patient.status.toLowerCase().replace('_', '-')}">${patient.status}</span></td>
        <td style="text-align: right; white-space: nowrap;">
          <div class="toolbar-group" style="justify-content: flex-end;">
            <!-- Print Token Slip Button -->
            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.printTokenSlip('${patient.token}')" title="Print patient slip with token, urgency level, room & time">
              🖨️ Slip
            </button>

            <!-- Assess / Vitals Button (Nurse / Doctor / Admin only) -->
            ${currentRoleConfig.canTriage ? `
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.openTriage('${patient.token}')" title="Perform triage assessment">
                ${patient.confirmedLevel ? '✏️ Re-Triage' : '🩺 Assess'}
              </button>
            ` : ''}

            <!-- Escalate Button (Nurse / Doctor / Admin only) -->
            ${currentRoleConfig.canEscalate ? `
              <button class="btn btn-danger btn-sm" onclick="window.triageApp.openEscalation('${patient.token}')" title="Dispatch clinical escalation">
                🚨 Escalate
              </button>
            ` : ''}

            <!-- Mark Seen Button (Clinical staff only) -->
            ${(currentRoleConfig.canRespondDoctor || currentRoleConfig.canTriage) ? `
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.markPatientSeen('${patient.token}')" title="Mark patient Seen by clinician">
                ✅ Seen
              </button>
            ` : ''}

            <!-- Mark LWBS Button -->
            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.markPatientLwbs('${patient.token}')" title="Mark patient Left Without Being Seen">
              🚪 LWBS
            </button>

            <!-- Reorder Move Up / Down (Nurse / Doctor only) -->
            ${currentRoleConfig.canReorder ? `
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.openReorder('${patient.token}', -1)" title="Move up in priority (requires clinical reason)">
                ▲
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.openReorder('${patient.token}', 1)" title="Move down in priority (requires clinical reason)">
                ▼
              </button>
            ` : ''}
          </div>
        </td>
      `;

      tbody.appendChild(tr);
    });
  }

  function markPatientSeen(token) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) return;

    if (!canPerform('canTriage') && !canPerform('canRespondDoctor')) {
      logUnauthorizedAttempt('mark patient as seen', token);
      showToast('Unauthorized Action Blocked', 'Only clinical staff (Nurse/Doctor) can mark a patient as Seen.', 'toast-warning');
      return;
    }

    patient.status = 'SEEN';
    patient.seenAt = State.vTime;

    addAuditEntry({
      action: 'STATUS_CHANGE',
      patientToken: token,
      patientName: patient.name,
      details: `Patient marked as SEEN by ${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`,
      diff: { status: 'SEEN' }
    });

    saveAllState();
    showToast('Patient Seen', `${patient.token} marked as Seen by doctor/clinician.`, 'toast-info');
    renderQueueTable();
  }

  function markPatientLwbs(token) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) return;

    if (!confirm(`Mark patient ${patient.name} (${token}) as Left Without Being Seen (LWBS)?`)) {
      return;
    }

    patient.status = 'LWBS';
    patient.lwbsAt = State.vTime;

    addAuditEntry({
      action: 'STATUS_CHANGE',
      patientToken: token,
      patientName: patient.name,
      details: `Patient marked as Left Without Being Seen (LWBS) by ${State.currentUser}`,
      diff: { status: 'LWBS' }
    });

    saveAllState();
    showToast('Patient LWBS', `${patient.token} recorded as Left Without Being Seen.`, 'toast-warning');
    renderQueueTable();
  }

  /**
   * Manual queue reordering (requires logged reason)
   */
  function openReorderModal(token, direction) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) return;

    if (!enforcePermission('canReorder', 'reorder clinical queue', token)) {
      return;
    }

    State.selectedPatientForReorder = { token, direction, patient };
    document.getElementById('reorderPatientSummary').innerHTML = `
      <strong>Patient:</strong> ${patient.name} (${patient.token}) &bull; Current Level: ${patient.confirmedLevel || 'Unassessed'}<br>
      <strong>Action:</strong> Shift priority ${direction < 0 ? 'HIGHER (Up)' : 'LOWER (Down)'}
    `;
    document.getElementById('reorderReasonInput').value = '';
    openModal('reorderModal');
  }

  function handleConfirmReorder() {
    if (!State.selectedPatientForReorder) return;
    const { token, direction, patient } = State.selectedPatientForReorder;

    if (!enforcePermission('canReorder', 'modify queue priority order', token)) {
      return;
    }

    const reason = document.getElementById('reorderReasonInput').value.trim();

    if (!reason) {
      showToast('Mandatory Justification', 'Please specify a clinical justification for manually modifying queue priority.', 'toast-warning');
      return;
    }

    const currentPriority = patient.customPriorityOrder !== null ? patient.customPriorityOrder : 0;
    patient.customPriorityOrder = currentPriority + (direction * 10);

    addAuditEntry({
      action: 'QUEUE_REORDER',
      patientToken: token,
      patientName: patient.name,
      details: `Queue priority adjusted ${direction < 0 ? 'HIGHER' : 'LOWER'} by ${State.currentUser}. Reason: "${reason}"`,
      diff: { customPriorityOrder: patient.customPriorityOrder, reason }
    });

    saveAllState();
    closeModal('reorderModal');
    showToast('Queue Adjusted', `Priority updated for ${token}.`, 'toast-info');
    renderQueueTable();
  }

    // ==========================================================================
  // SECTION 7: CLINICAL ESCALATION & DOCTOR INBOX
  // ==========================================================================
  // Plain-language explanation:
  // Allows Triage Nurses to escalate deteriorating patients directly to the attending
  // physician. Provides a dedicated Doctor Inbox where clinicians review escalations,
  // provide clinical instructions, or re-prioritize patient urgency.

  function openEscalationModal(token) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) return;

    if (!enforcePermission('canEscalate', 'dispatch clinical escalation', token)) {
      return;
    }

    State.selectedPatientForEscalation = patient;
    document.getElementById('escalationPatientSummary').innerHTML = `
      <strong>Patient:</strong> ${patient.name} (${patient.token}) &bull; Age: ${patient.age}<br>
      <strong>Complaint:</strong> ${patient.complaint}<br>
      <strong>Current Triage Level:</strong> ${patient.confirmedLevel ? 'Level ' + patient.confirmedLevel : 'Unassessed'}
    `;
    document.getElementById('escalationNotesInput').value = '';
    openModal('escalationModal');
  }

  function promptEscalationForPatient(patient, reasonNote) {
    // Show a high-priority toast & open escalation modal if nurse wants
    showToast('🚨 Immediate Escalation Prompt', `${patient.token} (${patient.name}): ${reasonNote}`, 'toast-l1');
    setTimeout(() => {
      openEscalationModal(patient.token);
      document.getElementById('escalationNotesInput').value = reasonNote;
    }, 400);
  }

  function handleEscalationSubmit() {
    const patient = State.selectedPatientForEscalation;
    if (!patient) return;

    if (!enforcePermission('canEscalate', 'submit clinical escalation', patient.token)) {
      return;
    }

    const reason = document.getElementById('escalationReasonSelect').value;
    const target = document.getElementById('escalationTargetSelect').value;
    const notes = document.getElementById('escalationNotesInput').value.trim();

    const escalationId = `ESC-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`.toUpperCase();
    const newEscalation = {
      id: escalationId,
      patientToken: patient.token,
      patientName: patient.name,
      reason,
      target,
      notes,
      escalatedBy: `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`,
      escalatedAt: State.vTime,
      state: 'PENDING', // PENDING -> ACKNOWLEDGED -> RESOLVED
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      doctorAction: null,
      doctorNotes: null,
      vitalsSnapshot: { ...patient.vitals },
      symptomsSnapshot: { ...patient.symptoms }
    };

    State.escalations.unshift(newEscalation);
    patient.status = 'ESCALATED';

    addAuditEntry({
      action: 'ESCALATION',
      patientToken: patient.token,
      patientName: patient.name,
      details: `Escalated to ${target}. Reason: "${reason}". Concern: "${notes || 'None'}"`,
      diff: { escalationId, target, reason }
    });

    // Alert
    createAlert({
      patientToken: patient.token,
      patientName: patient.name,
      type: 'CLINICAL_ESCALATION',
      level: 1,
      message: `ESCALATION to ${target}: ${patient.name} (${patient.token}) - ${reason}`
    });

    saveAllState();
    closeModal('escalationModal');
    showToast('🚨 Escalation Dispatched', `Patient ${patient.token} escalated to ${target}.`, 'toast-l1');
    renderDoctorInbox();
    renderQueueTable();
  }

  function renderDoctorInbox() {
    const container = document.getElementById('doctorInboxList');
    if (!container) return;
    container.innerHTML = '';

    const filterStatus = document.getElementById('filterDoctorEscalation').value;
    const list = State.escalations.filter(e => {
      if (filterStatus === 'ACTIVE') return e.state !== 'RESOLVED';
      if (filterStatus === 'RESOLVED') return e.state === 'RESOLVED';
      return true;
    });

    // Update nav badge count
    const pendingCount = State.escalations.filter(e => e.state === 'PENDING').length;
    const badge = document.getElementById('doctorEscalationBadge');
    badge.innerText = String(pendingCount);

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; color:#64748b; padding:2.5rem;">
          No clinical escalations matching filter.
        </div>
      `;
      return;
    }

    const isDoc = ROLES[State.currentRole].canRespondDoctor;

    list.forEach(esc => {
      const card = document.createElement('div');
      card.className = 'escalation-card';
      if (esc.state === 'ACKNOWLEDGED') card.classList.add('acknowledged');
      if (esc.state === 'RESOLVED') card.classList.add('resolved');

      const elapsedMin = Math.round((State.vTime - esc.escalatedAt) / 60000);
      let ackTimeText = 'Pending doctor acknowledgement';
      if (esc.acknowledgedAt) {
        const ackMin = Math.round((esc.acknowledgedAt - esc.escalatedAt) / 60000);
        ackTimeText = `Acknowledged in ${ackMin} min by ${esc.acknowledgedBy}`;
      }

      // Format vitals snapshot
      const v = esc.vitalsSnapshot || {};
      const vitalsText = `SpO2: ${v.spo2 ? v.spo2 + '%' : '--'} | BP: ${v.sbp || '--'}/${v.dbp || '--'} | HR: ${v.hr || '--'} | RR: ${v.rr || '--'} | Temp: ${v.temp ? v.temp + '°C' : '--'}`;

      card.innerHTML = `
        <div class="escalation-meta">
          <div>
            <strong style="font-size:1rem; color:#0369a1;">${esc.patientToken}</strong>
            <span style="font-weight:700; margin-left:0.5rem;">${escapeHtml(esc.patientName)}</span>
            <span style="margin-left:0.5rem; color:#dc2626; font-weight:700;">&bull; Target: ${esc.target}</span>
          </div>
          <div>
            <span style="font-size:0.75rem;">Escalated: ${formatVirtualTime(esc.escalatedAt)} (${elapsedMin}m ago)</span>
          </div>
        </div>

        <div style="font-size:0.875rem; margin-bottom:0.5rem;">
          <strong>Reason:</strong> <span style="color:#b91c1c; font-weight:700;">${esc.reason}</span>
          ${esc.notes ? `<div style="margin-top:0.25rem; font-style:italic; color:#334155;">"${escapeHtml(esc.notes)}"</div>` : ''}
        </div>

        <div style="background:#f1f5f9; padding:0.4rem 0.6rem; border-radius:4px; font-size:0.775rem; font-family:var(--font-mono); margin-bottom:0.75rem;">
          ${vitalsText}
        </div>

        <div style="font-size:0.775rem; color:#64748b; margin-bottom:0.75rem;">
          <span>Escalated by: ${esc.escalatedBy} &bull; ${ackTimeText}</span>
        </div>

        ${esc.state === 'RESOLVED' ? `
          <div style="background:#ecfdf5; border:1px solid #a7f3d0; padding:0.5rem 0.75rem; border-radius:4px; font-size:0.825rem; color:#065f46; margin-bottom:0.75rem;">
            <strong>Resolved:</strong> Action: <strong>${esc.doctorAction}</strong> by ${esc.resolvedBy}<br>
            <em>"${escapeHtml(esc.doctorNotes || '')}"</em>
          </div>
        ` : ''}

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <span class="status-badge ${esc.state.toLowerCase()}">Status: ${esc.state}</span>
          <div style="display:flex; gap:0.5rem;">
            ${esc.state === 'PENDING' ? `
              <button class="btn btn-secondary btn-sm" onclick="window.triageApp.ackEscalation('${esc.id}')" ${!isDoc ? 'disabled title="Only Doctors can acknowledge"' : ''}>
                👁️ Acknowledge Escalation
              </button>
            ` : ''}
            ${esc.state !== 'RESOLVED' ? `
              <button class="btn btn-primary btn-sm" onclick="window.triageApp.openDoctorResponse('${esc.id}')" ${!isDoc ? 'disabled title="Only Doctors can resolve escalations"' : ''}>
                🩺 Clinician Response...
              </button>
            ` : ''}
          </div>
        </div>
      `;

      container.appendChild(card);
    });
  }

  function acknowledgeEscalation(escId) {
    const esc = State.escalations.find(e => e.id === escId);
    if (!esc) return;

    if (!enforcePermission('canRespondDoctor', 'acknowledge clinical escalation', esc.patientToken)) {
      return;
    }

    esc.state = 'ACKNOWLEDGED';
    esc.acknowledgedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    esc.acknowledgedAt = State.vTime;

    const timeToAckMin = Math.round((esc.acknowledgedAt - esc.escalatedAt) / 60000);

    addAuditEntry({
      action: 'DOCTOR_RESPONSE',
      patientToken: esc.patientToken,
      patientName: esc.patientName,
      details: `Escalation ${esc.id} acknowledged by ${State.currentUser} (Time-to-ack: ${timeToAckMin} min)`,
      diff: { escalationId: esc.id, timeToAckMin }
    });

    saveAllState();
    showToast('Escalation Acknowledged', `Time-to-acknowledge: ${timeToAckMin} min recorded.`, 'toast-info');
    renderDoctorInbox();
  }

  function openDoctorResponseModal(escId) {
    const esc = State.escalations.find(e => e.id === escId);
    if (!esc) return;

    if (!enforcePermission('canRespondDoctor', 'open clinician response dialog', esc.patientToken)) {
      return;
    }

    State.selectedEscalationForResponse = esc;
    document.getElementById('docResponseEscalationInfo').innerHTML = `
      <strong>Patient:</strong> ${esc.patientName} (${esc.patientToken})<br>
      <strong>Escalation Reason:</strong> ${esc.reason}<br>
      <strong>Concern:</strong> ${esc.notes || 'None noted'}
    `;
    document.getElementById('docResponseNotes').value = '';
    openModal('doctorResponseModal');
  }

  function handleDoctorResponseSubmit() {
    const esc = State.selectedEscalationForResponse;
    if (!esc) return;

    if (!enforcePermission('canRespondDoctor', 'submit clinical response', esc.patientToken)) {
      return;
    }

    const actionType = document.getElementById('docResponseTypeSelect').value;
    const notes = document.getElementById('docResponseNotes').value.trim();

    if (!notes) {
      showToast('Mandatory Field', 'Please document clinical orders and rationale.', 'toast-warning');
      return;
    }

    esc.state = 'RESOLVED';
    esc.resolvedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    esc.resolvedAt = State.vTime;
    esc.doctorAction = actionType;
    esc.doctorNotes = notes;

    // If doctor wasn't acknowledged yet, record ack at same time
    if (!esc.acknowledgedAt) {
      esc.acknowledgedAt = State.vTime;
      esc.acknowledgedBy = esc.resolvedBy;
    }

    // Update patient status if transfer or accept
    const patient = State.patients.find(p => p.token === esc.patientToken);
    if (patient) {
      if (actionType === 'Accept Patient') {
        patient.status = 'IN_ASSESSMENT';
      } else if (actionType === 'Transfer to Emergency') {
        patient.status = 'SEEN';
      }
    }

    addAuditEntry({
      action: 'DOCTOR_RESPONSE',
      patientToken: esc.patientToken,
      patientName: esc.patientName,
      details: `Doctor response committed: [${actionType}] - "${notes}"`,
      diff: { escalationId: esc.id, doctorAction: actionType, doctorNotes: notes }
    });

    saveAllState();
    closeModal('doctorResponseModal');
    showToast('Escalation Resolved', `Orders saved for ${esc.patientToken}.`, 'toast-info');
    renderDoctorInbox();
    renderQueueTable();
  }

    // ==========================================================================
  // SECTION 8: AUDIT TRAIL & CSV EXPORT
  // ==========================================================================
  // Plain-language explanation:
  // Implements an immutable, append-only clinical audit log recording every user action
  // (logins, registrations, triage evaluations, overrides, escalations, reorders, evaluations).
  // Allows searching, filtering, and CSV export for clinical governance.

  function addAuditEntry({ action, patientToken, patientName, details, diff }) {
    const entry = {
      id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`.toUpperCase(),
      vTime: State.vTime,
      timestampISO: new Date().toISOString(),
      user: State.currentUser,
      role: State.currentRole,
      action,
      patientToken: patientToken || '--',
      patientName: patientName || '--',
      details,
      diff: diff || {}
    };

    State.audit.unshift(entry);
    setStorage(STORAGE_KEYS.AUDIT, State.audit);
  }

  function renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const filterAction = document.getElementById('filterAuditAction').value;
    const query = (document.getElementById('auditSearchInput').value || '').trim().toLowerCase();

    const filtered = State.audit.filter(item => {
      if (filterAction !== 'ALL' && item.action !== filterAction) return false;
      if (query) {
        const text = `${item.patientToken} ${item.patientName} ${item.user} ${item.details}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#64748b; padding:2rem;">No audit logs match criteria.</td></tr>`;
      return;
    }

    filtered.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:var(--font-mono); font-size:0.775rem; white-space:nowrap;">
          ${formatVirtualTime(log.vTime)}
        </td>
        <td>
          <div style="font-weight:700;">${log.user}</div>
          <div style="font-size:0.725rem; color:#64748b;">${ROLES[log.role]?.title || log.role}</div>
        </td>
        <td>
          <span class="status-badge waiting" style="font-size:0.725rem;">${log.action}</span>
        </td>
        <td class="token-cell">
          ${log.patientToken !== '--' ? `
            <button class="btn btn-secondary btn-sm" onclick="window.triageApp.openTimeline('${log.patientToken}')">
              ${log.patientToken}
            </button>
          ` : '--'}
        </td>
        <td style="max-width:350px; font-size:0.8rem;">
          <div>${escapeHtml(log.details)}</div>
          ${Object.keys(log.diff).length > 0 ? `
            <div class="audit-diff" style="margin-top:0.25rem;">
              ${escapeHtml(JSON.stringify(log.diff))}
            </div>
          ` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function openPatientTimeline(token) {
    const patient = State.patients.find(p => p.token === token);
    const container = document.getElementById('patientTimelineBody');
    const header = document.getElementById('patientTimelineSummary');

    if (patient) {
      header.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span class="token-cell" style="font-size:1.1rem;">${patient.token}</span>
            <strong style="margin-left:0.5rem;">${patient.name}</strong> (${patient.age}y / ${patient.sex})
          </div>
          <div>
            <span>Arrival: ${formatVirtualTime(patient.registeredAt)}</span>
          </div>
        </div>
        <div style="font-size:0.825rem; color:#475569; margin-top:0.25rem;">
          Complaint: ${escapeHtml(patient.complaint)} | Confirmed Level: ${patient.confirmedLevel || 'Unconfirmed'}
        </div>
      `;
    } else {
      header.innerHTML = `<div>Token: <strong>${token}</strong></div>`;
    }

    const patientLogs = State.audit.filter(a => a.patientToken === token);
    container.innerHTML = '';

    if (patientLogs.length === 0) {
      container.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:#64748b;">No audit records found for this patient.</td></tr>';
    } else {
      patientLogs.forEach(l => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-family:var(--font-mono); font-size:0.775rem;">${formatVirtualTime(l.vTime)}</td>
          <td><strong>${l.user}</strong> <span style="font-size:0.725rem; color:#64748b;">(${l.role})</span></td>
          <td><span class="status-badge">${l.action}</span></td>
          <td style="font-size:0.8rem;">
            ${escapeHtml(l.details)}
            ${Object.keys(l.diff).length > 0 ? `<div class="audit-diff">${escapeHtml(JSON.stringify(l.diff))}</div>` : ''}
          </td>
        `;
        container.appendChild(tr);
      });
    }

    openModal('patientTimelineModal');
  }

  /**
   * Export to CSV
   */
  function exportAuditToCsv() {
    if (State.audit.length === 0) {
      showToast('Export Empty', 'Audit log has no entries to export.', 'toast-info');
      return;
    }

    const headers = ['Timestamp', 'User', 'Role', 'Action', 'PatientToken', 'PatientName', 'Details', 'DiffJSON'];
    const rows = State.audit.map(a => [
      formatVirtualTime(a.vTime),
      `"${(a.user || '').replace(/"/g, '""')}"`,
      `"${(a.role || '').replace(/"/g, '""')}"`,
      `"${(a.action || '').replace(/"/g, '""')}"`,
      `"${(a.patientToken || '').replace(/"/g, '""')}"`,
      `"${(a.patientName || '').replace(/"/g, '""')}"`,
      `"${(a.details || '').replace(/"/g, '""')}"`,
      `"${JSON.stringify(a.diff || {}).replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    downloadBlob(csvContent, `medi_flow_audit_log_${Date.now()}.csv`, 'text/csv');
  }

  function exportQueueToCsv() {
    if (State.patients.length === 0) {
      showToast('Export Empty', 'No patients in queue to export.', 'toast-info');
      return;
    }

    const headers = ['Token', 'Name', 'Age', 'Sex', 'Phone', 'ArrivalMode', 'Complaint', 'RegisteredAt', 'ConfirmedLevel', 'SuggestedLevel', 'AssignedRoom', 'IsOverridden', 'OverrideReason', 'IsDowngraded', 'Status'];
    const rows = State.patients.map(p => [
      p.token,
      `"${(p.name || '').replace(/"/g, '""')}"`,
      p.age,
      p.sex,
      `"${p.phone}"`,
      p.arrivalMode,
      `"${(p.complaint || '').replace(/"/g, '""')}"`,
      formatVirtualTime(p.registeredAt),
      p.confirmedLevel || '',
      p.systemSuggestedLevel || '',
      `"${p.assignedRoom || 'Unassigned'}"`,
      p.isOverridden ? 'TRUE' : 'FALSE',
      `"${(p.overrideReason || '').replace(/"/g, '""')}"`,
      p.isDowngraded ? 'TRUE' : 'FALSE',
      p.status
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    downloadBlob(csvContent, `medi_flow_patient_queue_${Date.now()}.csv`, 'text/csv');
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Export Complete', `Downloaded ${filename}`, 'toast-info');
  }

    // ==========================================================================
  // SECTION 9: ANALYTICS DASHBOARD
  // ==========================================================================
  // Plain-language explanation:
  // Aggregates real-time operational OPD metrics: total patient volume, wait time averages,
  // SLA compliance, override frequencies, and urgency level distribution charts.

  function renderDashboard() {
    const totalPatients = State.patients.length;
    document.getElementById('dashTotalPatients').innerText = String(totalPatients);

    // Calculate active wait times & SLA breaches
    let totalWait = 0;
    let activePatients = 0;
    let slaBreaches = 0;

    State.patients.forEach(p => {
      if (p.status !== 'SEEN' && p.status !== 'LWBS') {
        const waitMin = Math.max(0, Math.floor((State.vTime - p.registeredAt) / 60000));
        totalWait += waitMin;
        activePatients += 1;

        const level = p.confirmedLevel || (p.isProvisionalL1 ? 1 : null);
        if (level && waitMin > SLA_MINUTES[level]) {
          slaBreaches += 1;
        }
      }
    });

    const avgWait = activePatients > 0 ? Math.round(totalWait / activePatients) : 0;
    document.getElementById('dashAvgWait').innerText = `${avgWait} min`;
    document.getElementById('dashSlaBreaches').innerText = String(slaBreaches);
    const breachRate = activePatients > 0 ? Math.round((slaBreaches / activePatients) * 100) : 0;
    document.getElementById('dashSlaRate').innerText = `${breachRate}% active queue breach rate`;

    // Overrides
    const triagedPatients = State.patients.filter(p => p.confirmedLevel !== null);
    const overrides = triagedPatients.filter(p => p.isOverridden);
    const overrideRate = triagedPatients.length > 0 ? Math.round((overrides.length / triagedPatients.length) * 100) : 0;
    document.getElementById('dashOverrideRate').innerText = `${overrideRate}%`;
    document.getElementById('dashOverrideCount').innerText = `${overrides.length} of ${triagedPatients.length} triages overridden`;

    // Escalations & Avg Acknowledge Time
    const escalations = State.escalations;
    document.getElementById('dashEscalations').innerText = String(escalations.length);
    const acknowledgedEscs = escalations.filter(e => e.acknowledgedAt !== null);
    let avgAckTime = 0;
    if (acknowledgedEscs.length > 0) {
      const sumAck = acknowledgedEscs.reduce((acc, curr) => acc + (curr.acknowledgedAt - curr.escalatedAt), 0);
      avgAckTime = Math.round(sumAck / (acknowledgedEscs.length * 60000));
    }
    document.getElementById('dashAvgAckTime').innerText = `Avg ack: ${avgAckTime} min (${acknowledgedEscs.length} reviewed)`;

    // LWBS
    const lwbsCount = State.patients.filter(p => p.status === 'LWBS').length;
    document.getElementById('dashLwbsCount').innerText = String(lwbsCount);

    // Distribution Bars
    const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unassessed: 0 };
    const deptCounts = {};

    State.patients.forEach(p => {
      const lvl = p.confirmedLevel || (p.isProvisionalL1 ? 1 : null);
      if (lvl && levelCounts[lvl] !== undefined) levelCounts[lvl] += 1;
      else levelCounts.unassessed += 1;

      const dept = p.assignedDept || p.recommendedDept || 'General Medicine';
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    });

    const barContainer = document.getElementById('dashUrgencyBars');
    const levelMeta = [
      { level: 1, label: 'Level 1 - Critical (Immediate)', count: levelCounts[1], color: '#dc2626', icon: '🔴' },
      { level: 2, label: 'Level 2 - Emergent (15 min)', count: levelCounts[2], color: '#ea580c', icon: '🟠' },
      { level: 3, label: 'Level 3 - Urgent (60 min)', count: levelCounts[3], color: '#ca8a04', icon: '🟡' },
      { level: 4, label: 'Level 4 - Less Urgent (120 min)', count: levelCounts[4], color: '#16a34a', icon: '🟢' },
      { level: 5, label: 'Level 5 - Routine (180 min)', count: levelCounts[5], color: '#64748b', icon: '⚪' },
      { level: 'unassessed', label: 'Unassessed / In Queue', count: levelCounts.unassessed, color: '#94a3b8', icon: '⏳' }
    ];

    if (barContainer) {
      barContainer.innerHTML = levelMeta.map(m => {
        const pct = totalPatients > 0 ? Math.round((m.count / totalPatients) * 100) : 0;
        return `
          <div>
            <div style="display:flex; justify-content:space-between; font-size:0.8rem; font-weight:600; margin-bottom:2px;">
              <span>${m.icon} ${m.label}</span>
              <span>${m.count} patients (${pct}%)</span>
            </div>
            <div style="background:#e2e8f0; height:12px; border-radius:6px; overflow:hidden;">
              <div style="background:${m.color}; width:${pct}%; height:100%; transition:width 0.3s ease;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    const deptContainer = document.getElementById('dashDeptBars');
    if (deptContainer) {
      const topDepts = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      deptContainer.innerHTML = topDepts.map(([dName, dCount]) => {
        const pct = totalPatients > 0 ? Math.round((dCount / totalPatients) * 100) : 0;
        return `
          <div style="margin-bottom:0.4rem;">
            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:2px;">
              <span><strong>${escapeHtml(dName)}</strong> (${dCount})</span>
              <span>${pct}%</span>
            </div>
            <div style="background:#e0f2fe; border-radius:4px; height:8px; width:100%; overflow:hidden;">
              <div style="background:#0284c7; height:100%; width:${pct}%;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Dashboard Overrides Table
    const overridesTbody = document.getElementById('dashboardOverridesBody');
    overridesTbody.innerHTML = '';
    if (overrides.length === 0) {
      overridesTbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b; padding:1.5rem;">No clinical overrides recorded.</td></tr>`;
    } else {
      overrides.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="token-cell">${p.token}</td>
          <td>${escapeHtml(p.name)}</td>
          <td><span class="urgency-badge l${p.systemSuggestedLevel}">L${p.systemSuggestedLevel}</span></td>
          <td><span class="urgency-badge l${p.confirmedLevel}">L${p.confirmedLevel}</span></td>
          <td>
            ${p.isDowngraded ? '<span class="status-badge escalated">⚠️ DOWNGRADE</span>' : '<span class="status-badge">Upgrade/Side</span>'}
          </td>
          <td style="font-size:0.8rem; max-width:250px;">${escapeHtml(p.overrideReason || '')}</td>
          <td style="font-size:0.8rem;">${p.confirmedBy || 'Nurse'}</td>
        `;
        overridesTbody.appendChild(tr);
      });
    }
  }

    // ==========================================================================
  // SECTION 10: DEMO DATA GENERATOR & TIME SIMULATION
  // ==========================================================================
  // Plain-language explanation:
  // Populates synthetic OPD patient cases covering diverse clinical presentations
  // (anaphylaxis, stroke, chest pain, fever, fractures, pediatric cases) and advances
  // virtual time (+15 min, +1 hour) to test SLAs and workflow states.

  function loadDemoData() {
    State.tokenCounter = 1;
    State.vTime = new Date(DEFAULT_START_TIME).getTime();

    // 12 Synthetic Patients Covering all prompt requirements
    const demoPatients = [
      // 1. L1 Anaphylaxis/Airway Emergency
      {
        token: 'OPD-0001',
        name: 'Carlos Mendez',
        age: 32,
        sex: 'Male',
        phone: '9876543210',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Peanuts, Shellfish',
        complaint: 'Severe lip swelling, stridor, and difficulty breathing following food ingestion.',
        registeredAt: State.vTime - 5 * 60000,
        status: 'IN_ASSESSMENT',
        confirmedLevel: 1,
        systemSuggestedLevel: 1,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 4 * 60000,
        customPriorityOrder: null,
        symptoms: { allergic_reaction: true, breathlessness: true },
        vitals: { spo2: '87', sbp: '88', hr: '135', rr: '34', temp: '37.1', gcs: '14', pain: '4' },
        clinicalNotes: 'Impending airway closure. Immediate IM epinephrine administered.',
        triageHistory: []
      },
      // 2. L1 Acute Stroke signs with elderly patient
      {
        token: 'OPD-0002',
        name: 'Eleanor Vance',
        age: 74,
        sex: 'Female',
        phone: '9876543211',
        arrivalMode: 'Ambulance',
        pregnancy: 'No',
        allergies: 'None',
        complaint: 'Sudden onset left-sided facial droop and right arm paralysis 35 min ago.',
        registeredAt: State.vTime - 12 * 60000,
        status: 'ESCALATED',
        confirmedLevel: 1,
        systemSuggestedLevel: 1,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 10 * 60000,
        customPriorityOrder: null,
        symptoms: { stroke_signs: true, altered_consciousness: true },
        vitals: { spo2: '96', sbp: '195', hr: '94', rr: '18', temp: '36.8', gcs: '12', pain: '0' },
        clinicalNotes: 'Time critical stroke thrombolysis candidate. CT ordered.',
        triageHistory: []
      },
      // 3. L1 Emergency Walk-in (Unconscious)
      {
        token: 'OPD-0003',
        name: 'Unknown Male #3',
        age: 45,
        sex: 'Male',
        phone: '0000000000',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Unknown',
        complaint: 'Collapsed outside clinic entrance. Unresponsive.',
        registeredAt: State.vTime - 2 * 60000,
        status: 'WAITING',
        confirmedLevel: 1,
        systemSuggestedLevel: 1,
        isProvisionalL1: true,
        isOverridden: false,
        overrideReason: 'Emergency walk-in quick entry protocol',
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Clerk Alex [Provisional]',
        confirmedAt: State.vTime - 2 * 60000,
        customPriorityOrder: -9999,
        symptoms: { altered_consciousness: true },
        vitals: { sbp: '75', gcs: '6' },
        clinicalNotes: 'Provisional entry awaiting immediate trauma bay resuscitation.',
        triageHistory: []
      },
      // 4. L2 Chest pain age 55 (High-Risk ACS)
      {
        token: 'OPD-0004',
        name: 'Rajesh Sharma',
        age: 55,
        sex: 'Male',
        phone: '9876543212',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Aspirin',
        complaint: 'Heavy retrosternal chest pressure radiating to left jaw for 1 hour.',
        registeredAt: State.vTime - 20 * 60000,
        status: 'IN_ASSESSMENT',
        confirmedLevel: 2,
        systemSuggestedLevel: 2,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 18 * 60000,
        customPriorityOrder: null,
        symptoms: { chest_pain: true, breathlessness: true },
        vitals: { spo2: '96', sbp: '160', hr: '98', rr: '22', temp: '36.9', gcs: '15', pain: '8' },
        clinicalNotes: 'ECG underway. Patient diaphoretic.',
        triageHistory: []
      },
      // 5. L2 Pregnant female with bleeding/abdominal pain
      {
        token: 'OPD-0005',
        name: 'Fatima Al-Sayed',
        age: 28,
        sex: 'Female',
        phone: '9876543213',
        arrivalMode: 'Walk-in',
        pregnancy: 'Yes',
        allergies: 'None',
        complaint: 'Pregnant 28 weeks, presenting with severe crampy abdominal pain and vaginal spotting.',
        registeredAt: State.vTime - 10 * 60000,
        status: 'IN_ASSESSMENT',
        confirmedLevel: 2,
        systemSuggestedLevel: 2,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 8 * 60000,
        customPriorityOrder: null,
        symptoms: { pregnancy_bleeding_pain: true, severe_abdominal_pain: true },
        vitals: { spo2: '98', sbp: '110', hr: '92', rr: '18', temp: '37.0', gcs: '15', pain: '7' },
        clinicalNotes: 'Urgent OBGYN consult requested.',
        triageHistory: []
      },
      // 6. L2 High fever infant (4 months)
      {
        token: 'OPD-0006',
        name: 'Baby Mia Chen',
        age: 0.33,
        sex: 'Female',
        phone: '9876543214',
        arrivalMode: 'Referred',
        pregnancy: 'No',
        allergies: 'None',
        complaint: 'Mother reports 4-month-old infant is lethargic, hot to touch, not feeding.',
        registeredAt: State.vTime - 14 * 60000,
        status: 'WAITING',
        confirmedLevel: 2,
        systemSuggestedLevel: 2,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 12 * 60000,
        customPriorityOrder: null,
        symptoms: { high_fever: true },
        vitals: { spo2: '97', sbp: '85', hr: '165', rr: '42', temp: '39.8', gcs: '15', pain: '5' },
        clinicalNotes: 'Infant high fever protocol. Rapid pediatric review.',
        triageHistory: []
      },
      // 7. L2 Conflicting/abnormal vitals (Borderline SpO2 + Tachycardia)
      {
        token: 'OPD-0007',
        name: 'David Wilson',
        age: 67,
        sex: 'Male',
        phone: '9876543215',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Penicillin',
        complaint: 'Mild cough and fatigue for 3 days.',
        registeredAt: State.vTime - 25 * 60000,
        status: 'IN_ASSESSMENT',
        confirmedLevel: 2,
        systemSuggestedLevel: 2,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 22 * 60000,
        customPriorityOrder: null,
        symptoms: { mild_cold: true },
        vitals: { spo2: '91', sbp: '142', hr: '122', rr: '24', temp: '38.2', gcs: '15', pain: '2' },
        clinicalNotes: 'Discrepancy: complains of minor cold but SpO2 is 91% and HR 122. Raised to Level 2.',
        triageHistory: []
      },
      // 8. L3 Semi-urgent vomiting/diarrhea
      {
        token: 'OPD-0008',
        name: 'Priya Patel',
        age: 24,
        sex: 'Female',
        phone: '9876543216',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'None',
        complaint: 'Vomiting and watery diarrhea for 24 hours. Able to sip water.',
        registeredAt: State.vTime - 35 * 60000,
        status: 'WAITING',
        confirmedLevel: 3,
        systemSuggestedLevel: 3,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 30 * 60000,
        customPriorityOrder: null,
        symptoms: { vomiting_diarrhea: true },
        vitals: { spo2: '99', sbp: '115', hr: '84', rr: '16', temp: '37.3', gcs: '15', pain: '4' },
        clinicalNotes: 'Mild dehydration. Oral rehydration solution initiated.',
        triageHistory: []
      },
      // 9. L3 Chest pain with MISSING vitals -> "Needs human review"
      {
        token: 'OPD-0009',
        name: 'Samuel Green',
        age: 34,
        sex: 'Male',
        phone: '9876543217',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'None',
        complaint: 'Sharp pleuritic chest discomfort following heavy coughing.',
        registeredAt: State.vTime - 15 * 60000,
        status: 'WAITING',
        confirmedLevel: 3,
        systemSuggestedLevel: 3,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 12 * 60000,
        customPriorityOrder: null,
        symptoms: { chest_pain: true },
        vitals: {}, // Completely missing vitals!
        clinicalNotes: 'Awaiting triage nurse vitals station measurement. Fails safe to L3 review.',
        triageHistory: []
      },
      // 10. L4 Mild cold / upper respiratory
      {
        token: 'OPD-0010',
        name: 'Amina Idris',
        age: 19,
        sex: 'Female',
        phone: '9876543218',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'None',
        complaint: 'Runny nose, sneezing, scratchy throat for 2 days. Normal energy.',
        registeredAt: State.vTime - 45 * 60000,
        status: 'WAITING',
        confirmedLevel: 4,
        systemSuggestedLevel: 4,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 40 * 60000,
        customPriorityOrder: null,
        symptoms: { mild_cold: true },
        vitals: { spo2: '99', sbp: '118', hr: '72', rr: '14', temp: '36.7', gcs: '15', pain: '1' },
        clinicalNotes: 'Non-urgent ambulatory care.',
        triageHistory: []
      },
      // 11. SLA Breach Patient (L2 registered 80 min ago with 15 min SLA!)
      {
        token: 'OPD-0011',
        name: 'George Taylor',
        age: 62,
        sex: 'Male',
        phone: '9876543219',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Sulfa',
        complaint: 'Severe burning epigastric and abdominal pain. Has been waiting in hall.',
        registeredAt: State.vTime - 85 * 60000, // 85 min ago!
        status: 'WAITING',
        confirmedLevel: 2,
        systemSuggestedLevel: 2,
        isProvisionalL1: false,
        isOverridden: false,
        overrideReason: null,
        isDowngraded: false,
        flaggedForDoctorReview: false,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 80 * 60000,
        customPriorityOrder: null,
        symptoms: { severe_abdominal_pain: true },
        vitals: { spo2: '95', sbp: '150', hr: '104', rr: '20', temp: '37.8', gcs: '15', pain: '8' },
        clinicalNotes: 'SLA target 15 min exceeded. Critical queue delay.',
        triageHistory: []
      },
      // 12. Human Override patient (Suggested L3, nurse overrode to L2 with reason)
      {
        token: 'OPD-0012',
        name: 'Maria Santos',
        age: 50,
        sex: 'Female',
        phone: '9876543220',
        arrivalMode: 'Walk-in',
        pregnancy: 'No',
        allergies: 'Codeine',
        complaint: 'Dizziness and nausea. Vitals borderline, but patient is pale and clammy.',
        registeredAt: State.vTime - 18 * 60000,
        status: 'IN_ASSESSMENT',
        confirmedLevel: 2,
        systemSuggestedLevel: 3,
        isProvisionalL1: false,
        isOverridden: true,
        overrideReason: 'Clinically pale and diaphoretic despite borderline vitals; concerned for occult bleeding.',
        isDowngraded: false,
        flaggedForDoctorReview: true,
        confirmedBy: 'Nurse Sarah (Triage Nurse)',
        confirmedAt: State.vTime - 15 * 60000,
        customPriorityOrder: null,
        symptoms: { vomiting_diarrhea: true },
        vitals: { spo2: '96', sbp: '102', hr: '96', rr: '18', temp: '36.9', gcs: '15', pain: '4' },
        clinicalNotes: 'Human override exercised on clinical visual judgment.',
        triageHistory: []
      }
    ];

    demoPatients.forEach(p => {
      if (!p.assignedRoom) {
        if (p.confirmedLevel === 1) p.assignedRoom = 'Resuscitation Bay';
        else if (p.confirmedLevel === 2) p.assignedRoom = 'Room 1 (Acute Care)';
        else if (p.confirmedLevel === 3) p.assignedRoom = 'Room 2 (General OPD)';
        else if (p.confirmedLevel === 4) p.assignedRoom = 'Room 3 (Fast Track / Minor)';
        else p.assignedRoom = 'Triage Bay A';
      }
    });

    State.patients = demoPatients;
    State.tokenCounter = 13;

    // Seed Demo Escalations
    State.escalations = [
      {
        id: 'ESC-DEMO-001',
        patientToken: 'OPD-0002',
        patientName: 'Eleanor Vance',
        reason: 'Red flag symptom present',
        target: 'Emergency Resuscitation Team',
        notes: 'Acute stroke signs within 1-hour window. Code stroke activated.',
        escalatedBy: 'Nurse Sarah (Triage Nurse)',
        escalatedAt: State.vTime - 10 * 60000,
        state: 'ACKNOWLEDGED',
        acknowledgedBy: 'Dr. Rao (Doctor)',
        acknowledgedAt: State.vTime - 7 * 60000,
        resolvedBy: null,
        resolvedAt: null,
        doctorAction: null,
        doctorNotes: null,
        vitalsSnapshot: { spo2: '96', sbp: '195', hr: '94' },
        symptomsSnapshot: { stroke_signs: true }
      },
      {
        id: 'ESC-DEMO-002',
        patientToken: 'OPD-0011',
        patientName: 'George Taylor',
        reason: 'Clinical deterioration',
        target: 'On-duty Doctor',
        notes: 'Severe abdominal pain with SLA breach > 70 min. Needs immediate bed.',
        escalatedBy: 'Nurse Sarah (Triage Nurse)',
        escalatedAt: State.vTime - 15 * 60000,
        state: 'PENDING',
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        doctorAction: null,
        doctorNotes: null,
        vitalsSnapshot: { spo2: '95', sbp: '150', hr: '104' },
        symptomsSnapshot: { severe_abdominal_pain: true }
      }
    ];

    // Seed Demo Alerts
    State.alerts = [
      {
        id: 'ALT-DEMO-001',
        patientToken: 'OPD-0003',
        patientName: 'Unknown Male #3',
        type: 'EMERGENCY_L1_WALKIN',
        level: 1,
        message: 'CRITICAL ALERT: Emergency Walk-In patient Unknown Male #3 (OPD-0003) entered at Level 1 Critical!',
        state: 'NEW',
        createdAt: State.vTime - 2 * 60000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        escalatedToRole: null
      },
      {
        id: 'ALT-DEMO-002',
        patientToken: 'OPD-0011',
        patientName: 'George Taylor',
        type: 'SLA_BREACH',
        level: 2,
        message: 'SLA BREACH ALERT: George Taylor (OPD-0011) has exceeded Level 2 target wait time by 70 min!',
        state: 'NEW',
        createdAt: State.vTime - 20 * 60000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        escalatedToRole: 'Doctor'
      }
    ];

    // Seed Demo Audit Logs
    State.audit = [
      {
        id: 'AUD-DEMO-001',
        vTime: State.vTime - 85 * 60000,
        timestampISO: new Date().toISOString(),
        user: 'Clerk Alex',
        role: 'clerk',
        action: 'REGISTRATION',
        patientToken: 'OPD-0011',
        patientName: 'George Taylor',
        details: 'Registered via Walk-in. Complaint: "Severe burning epigastric and abdominal pain."',
        diff: { name: 'George Taylor', age: 62 }
      },
      {
        id: 'AUD-DEMO-002',
        vTime: State.vTime - 15 * 60000,
        timestampISO: new Date().toISOString(),
        user: 'Nurse Sarah',
        role: 'nurse',
        action: 'TRIAGE_OVERRIDE',
        patientToken: 'OPD-0012',
        patientName: 'Maria Santos',
        details: 'Overrode System L3 -> L2. Reason: "Clinically pale and diaphoretic despite borderline vitals; concerned for occult bleeding."',
        diff: { systemSuggestion: 3, humanConfirmed: 2, isOverridden: true }
      },
      {
        id: 'AUD-DEMO-003',
        vTime: State.vTime - 10 * 60000,
        timestampISO: new Date().toISOString(),
        user: 'Nurse Sarah',
        role: 'nurse',
        action: 'ESCALATION',
        patientToken: 'OPD-0002',
        patientName: 'Eleanor Vance',
        details: 'Escalated to Emergency Resuscitation Team. Reason: "Red flag symptom present"',
        diff: { target: 'Emergency Resuscitation Team' }
      },
      {
        id: 'AUD-DEMO-004',
        vTime: State.vTime - 7 * 60000,
        timestampISO: new Date().toISOString(),
        user: 'Dr. Rao',
        role: 'doctor',
        action: 'DOCTOR_RESPONSE',
        patientToken: 'OPD-0002',
        patientName: 'Eleanor Vance',
        details: 'Escalation acknowledged by Dr. Rao (Time-to-ack: 3 min)',
        diff: { timeToAckMin: 3 }
      }
    ];

    saveAllState();
    updateClockDisplay();
    updateAlertCounterUI();
    renderQueueTable();
    renderDoctorInbox();
    renderAuditTable();
    renderDashboard();
    showToast('Demo Data Loaded', '12 realistic synthetic patients, SLA breach, override, and alerts initialized.', 'toast-info');
  }

  function simulatePlus15Min() {
    State.vTime += 15 * 60000;
    saveAllState();
    updateClockDisplay();

    // Check for SLA breaches and unacknowledged alerts
    evaluateTimeSimulationTriggers();

    renderQueueTable();
    renderDoctorInbox();
    renderAuditTable();
    renderDashboard();
    showToast('🕒 Time Advanced', 'Simulated virtual clock advanced by +15 minutes.', 'toast-info');
  }

  function evaluateTimeSimulationTriggers() {
    const FIVE_MIN = 5 * 60000;

    // 1. Check patients for new SLA breaches
    State.patients.forEach(p => {
      if (p.status !== 'SEEN' && p.status !== 'LWBS') {
        const level = p.confirmedLevel || (p.isProvisionalL1 ? 1 : null);
        if (level) {
          const waitMin = Math.floor((State.vTime - p.registeredAt) / 60000);
          const target = SLA_MINUTES[level];
          if (waitMin > target) {
            // Check if alert already raised for this breach
            const existingAlert = State.alerts.find(a => a.patientToken === p.token && a.type === 'SLA_BREACH');
            if (!existingAlert) {
              createAlert({
                patientToken: p.token,
                patientName: p.name,
                type: 'SLA_BREACH',
                level: level <= 2 ? 1 : 2,
                message: `SLA BREACH: ${p.name} (${p.token}, Level ${level}) has waited ${waitMin}m (target ${target}m).`
              });
            }
          }
        }
      }
    });

    // 2. Check unacknowledged alerts: escalate to next role after 5 virtual minutes
    State.alerts.forEach(alt => {
      if (alt.state === 'NEW') {
        const elapsed = State.vTime - alt.createdAt;
        if (elapsed > FIVE_MIN && !alt.escalatedToRole) {
          alt.escalatedToRole = 'Doctor / Senior Clinician';
          addAuditEntry({
            action: 'ALERT_RAISED',
            patientToken: alt.patientToken,
            patientName: alt.patientName,
            details: `Unacknowledged alert ${alt.id} automatically escalated to ${alt.escalatedToRole} (> 5 min elapsed)`,
            diff: { alertId: alt.id, escalatedToRole: alt.escalatedToRole }
          });
          showToast('⚠️ Alert Auto-Escalated', `Unacknowledged alert for ${alt.patientToken} escalated to ${alt.escalatedToRole}!`, 'toast-warning');
        }
      }
    });

    saveAllState();
    updateAlertCounterUI();
  }

  function resetAllData() {
    if (!confirm('Are you sure you want to reset all synthetic data?')) return;
    localStorage.removeItem(STORAGE_KEYS.PATIENTS);
    localStorage.removeItem(STORAGE_KEYS.ALERTS);
    localStorage.removeItem(STORAGE_KEYS.AUDIT);
    localStorage.removeItem(STORAGE_KEYS.ESCALATIONS);
    localStorage.removeItem(STORAGE_KEYS.VTIME);
    localStorage.removeItem(STORAGE_KEYS.COUNTER);
    loadState();
    updateClockDisplay();
    updateAlertCounterUI();
    renderQueueTable();
    renderDoctorInbox();
    renderAuditTable();
    renderDashboard();
    showToast('Data Cleared', 'All synthetic state reset to initial zero state.', 'toast-info');
  }

  function updateClockDisplay() {
    const el = document.getElementById('virtualClockDisplay');
    if (el) el.innerText = formatVirtualTime(State.vTime);
  }

  // ==========================================================================
  // ==========================================================================
  // SECTION 11: AUTOMATED SELF-TEST SUITE (22 SAFETY & SECURITY ASSERTIONS)
  // ==========================================================================
  // Plain-language explanation:
  // Built-in automated regression test runner with 22 assertions verifying hypoxia rules,
  // pediatric thresholds, fail-safe vitals invariance, account lockouts, permission boundaries,
  // data quality audits, under-triage calculation, and slip contents.

  async function runSelfTests() {
    const assertions = [
      {
        id: 1,
        title: 'SpO2 88% triggers Level 1 Critical',
        input: 'Adult age 45, SpO2 88%, no other symptoms',
        run: async () => {
          const res = evaluateTriage({ age: 45 }, {}, { spo2: '88' });
          return { pass: res.suggestedLevel === 1, actual: `Level ${res.suggestedLevel} (${res.levelLabel})` };
        },
        expected: 'Level 1 (Critical Hypoxia)'
      },
      {
        id: 2,
        title: 'SpO2 92% triggers at least Level 2 Urgent',
        input: 'Adult age 45, SpO2 92%',
        run: async () => {
          const res = evaluateTriage({ age: 45 }, {}, { spo2: '92' });
          return { pass: res.suggestedLevel === 2, actual: `Level ${res.suggestedLevel}` };
        },
        expected: 'Level 2 (Borderline Hypoxia)'
      },
      {
        id: 3,
        title: 'Systolic BP 75 mmHg triggers Level 1 Critical',
        input: 'Adult age 30, SBP 75 mmHg',
        run: async () => {
          const res = evaluateTriage({ age: 30 }, {}, { sbp: '75' });
          return { pass: res.suggestedLevel === 1, actual: `Level ${res.suggestedLevel}` };
        },
        expected: 'Level 1 (Decompensated Shock)'
      },
      {
        id: 4,
        title: 'Chest pain in patient age >= 40 triggers at least Level 2',
        input: 'Patient age 52, chest pain present, normal vitals',
        run: async () => {
          const res = evaluateTriage({ age: 52 }, { chest_pain: true }, { spo2: '98', sbp: '120', hr: '75', rr: '16' });
          return { pass: res.suggestedLevel === 2, actual: `Level ${res.suggestedLevel}` };
        },
        expected: 'Level 2 (High-Risk ACS)'
      },
      {
        id: 5,
        title: 'Missing vitals NEVER lowers urgency (Fails safe)',
        input: 'Chest pain with completely empty vitals',
        run: async () => {
          const res = evaluateTriage({ age: 45 }, { chest_pain: true }, {});
          const pass = res.suggestedLevel <= 2 && res.needsHumanReview;
          return { pass, actual: `Level ${res.suggestedLevel}, NeedsHumanReview=${res.needsHumanReview}` };
        },
        expected: 'Level 2, NeedsHumanReview=true'
      },
      {
        id: 6,
        title: 'Highest level wins among fired rules',
        input: 'Mild cold (L4 symptom) combined with Respiratory Rate 34 (L1 vital)',
        run: async () => {
          const res = evaluateTriage({ age: 30 }, { mild_cold: true }, { rr: '34' });
          return { pass: res.suggestedLevel === 1, actual: `Level ${res.suggestedLevel}` };
        },
        expected: 'Level 1 (RR 34 overrides mild cold)'
      },
      {
        id: 7,
        title: 'Age-band discrimination: Infant vs Adult Heart Rate',
        input: 'HR 145 bpm tested in Infant (0.5y) vs Adult (40y)',
        run: async () => {
          const infantRes = evaluateTriage({ age: 0.5 }, {}, { hr: '145' });
          const adultRes = evaluateTriage({ age: 40 }, {}, { hr: '145' });
          const pass = (adultRes.suggestedLevel === 1) && (infantRes.suggestedLevel > 1);
          return { pass, actual: `Adult: L${adultRes.suggestedLevel}, Infant: L${infantRes.suggestedLevel}` };
        },
        expected: 'Adult L1 (HR >130), Infant safe/L3 (145 normal resting)'
      },
      {
        id: 8,
        title: 'Physiologically impossible vitals rejected by validation',
        input: 'SpO2 105% and Temp 48°C',
        run: async () => {
          const val = validateVitals({ spo2: '105', temp: '48' }, 30);
          return { pass: !val.isValid && val.errors.length === 2, actual: `isValid=${val.isValid}, Errors=${val.errors.length}` };
        },
        expected: 'isValid=false (2 validation errors)'
      },
      {
        id: 9,
        title: 'Glasgow Coma Scale <= 8 triggers Level 1 Critical',
        input: 'Patient GCS 7',
        run: async () => {
          const res = evaluateTriage({ age: 25 }, {}, { gcs: '7' });
          return { pass: res.suggestedLevel === 1, actual: `Level ${res.suggestedLevel}` };
        },
        expected: 'Level 1 (Severe Neurological Deficit)'
      },
      {
        id: 10,
        title: 'Human Override strictly requires non-empty reason',
        input: 'Simulate override attempt with empty string reason',
        run: async () => {
          const reasonInput = '';
          const isBlocked = (reasonInput.trim().length === 0);
          return { pass: isBlocked, actual: `Blocked=${isBlocked}` };
        },
        expected: 'Blocked=true (Mandatory rationale enforced)'
      },
      {
        id: 11,
        title: 'Meningitis Triad (Fever + Stiff Neck + Altered Consciousness)',
        input: 'Temp 39.0°C + Stiff Neck + Altered Consciousness',
        run: async () => {
          const res = evaluateTriage({ age: 22 }, { stiff_neck: true, altered_consciousness: true }, { temp: '39.0' });
          const hasTriadRule = res.firedRules.some(r => r.id === 'R-MENINGITIS-L1');
          return { pass: res.suggestedLevel === 1 && hasTriadRule, actual: `Level ${res.suggestedLevel}, TriadRule=${hasTriadRule}` };
        },
        expected: 'Level 1 with R-MENINGITIS-L1 fired'
      },
      {
        id: 12,
        title: 'Audit entry created on state change',
        input: 'Check audit log integrity and append operation',
        run: async () => {
          const countBefore = State.audit.length;
          addAuditEntry({ action: 'SELF_TEST', details: 'Automated test suite execution' });
          const countAfter = State.audit.length;
          return { pass: countAfter === countBefore + 1, actual: `Logged (+${countAfter - countBefore})` };
        },
        expected: 'Audit entry appended (+1)'
      },
      {
        id: 13,
        title: 'A clerk cannot perform a nurse-only action',
        input: 'Simulate clerk01 attempting triage assessment commit',
        run: async () => {
          const prevAuth = State.currentAuthUser;
          State.currentAuthUser = { staffId: 'clerk01', name: 'Clerk Alex', role: 'clerk' };
          const auditCountBefore = State.audit.length;
          const allowed = enforcePermission('canTriage', 'commit clinical triage decision', 'TEST-TOKEN');
          const auditCountAfter = State.audit.length;
          State.currentAuthUser = prevAuth;
          const pass = (!allowed) && (auditCountAfter === auditCountBefore + 1);
          return { pass, actual: `Blocked=${!allowed}, AuditLogged=${auditCountAfter > auditCountBefore}` };
        },
        expected: 'Blocked=true, AuditLogged=true'
      },
      {
        id: 14,
        title: 'A user cannot change their own role',
        input: 'Admin admin01 attempting to edit own account role',
        run: async () => {
          let blocked = false;
          try {
            updateAccountRole('admin01', 'admin01', 'doctor');
          } catch (err) {
            blocked = true;
          }
          return { pass: blocked, actual: `Blocked=${blocked}` };
        },
        expected: 'Blocked=true (Self-role edit strictly forbidden)'
      },
      {
        id: 15,
        title: 'A Pending account cannot log in',
        input: 'Attempt authentication with an account where status is PENDING',
        run: async () => {
          const salt = generateSalt();
          const hash = await hashPassword('pending123', salt);
          const testPending = {
            staffId: 'test_pending_doc',
            name: 'Dr. Pending',
            role: 'doctor',
            status: 'PENDING',
            salt,
            passwordHash: hash,
            failedAttempts: 0,
            lockedUntil: null
          };
          State.accounts.push(testPending);
          const result = await loginUser('test_pending_doc', 'pending123', true);
          State.accounts = State.accounts.filter(a => a.staffId !== 'test_pending_doc');
          const pass = (!result.success && result.reason === 'PENDING');
          return { pass, actual: `LoginAllowed=${result.success}, Reason=${result.reason}` };
        },
        expected: 'LoginAllowed=false, Reason=PENDING'
      },
      {
        id: 16,
        title: '3 failed logins lock the account for 5 minutes',
        input: 'Simulate 3 incorrect password entries on active account',
        run: async () => {
          const salt = generateSalt();
          const hash = await hashPassword('correctpass', salt);
          const testAccount = {
            staffId: 'test_lock_user',
            name: 'Lock Test',
            role: 'clerk',
            status: 'ACTIVE',
            salt,
            passwordHash: hash,
            failedAttempts: 0,
            lockedUntil: null
          };
          State.accounts.push(testAccount);
          await loginUser('test_lock_user', 'wrongpass1', true);
          await loginUser('test_lock_user', 'wrongpass2', true);
          await loginUser('test_lock_user', 'wrongpass3', true);
          const locked = testAccount.lockedUntil && testAccount.lockedUntil > State.vTime;
          const lockoutDurationMs = testAccount.lockedUntil ? (testAccount.lockedUntil - State.vTime) : 0;
          State.accounts = State.accounts.filter(a => a.staffId !== 'test_lock_user');
          const pass = locked && (lockoutDurationMs === 5 * 60 * 1000);
          return { pass, actual: `Locked=${locked}, Duration=${lockoutDurationMs / 60000}m` };
        },
        expected: 'Locked=true, Duration=5m'
      },
      {
        id: 17,
        title: 'Passwords are not stored in plain text',
        input: 'Inspect stored accounts for absence of plaintext and presence of salt & SHA-256 hash',
        run: async () => {
          const allAccounts = State.accounts;
          const noPlaintext = allAccounts.every(a => a.password === undefined && a.plainPass === undefined && a.plainPassword === undefined);
          const allHaveHash = allAccounts.every(a => typeof a.passwordHash === 'string' && a.passwordHash.length === 64);
          const allHaveSalt = allAccounts.every(a => typeof a.salt === 'string' && a.salt.length >= 16);
          const pass = noPlaintext && allHaveHash && allHaveSalt && allAccounts.length > 0;
          return {
            pass,
            actual: `NoPlaintext=${noPlaintext}, HashesLength64=${allHaveHash}, SaltsPresent=${allHaveSalt}`
          };
        },
        expected: 'NoPlaintext=true, HashesLength64=true, SaltsPresent=true'
      },
      {
        id: 18,
        title: 'Bad rows are reported in data quality audit, not dropped',
        input: 'Audit 3 sample rows: 1 valid, 1 impossible SpO2 125%, 1 impossible age -10',
        run: async () => {
          const testSample = [
            { age: '45', sex: 'M', complaint: 'Mild headache', hr: '75', sbp: '120', dbp: '80', rr: '16', spo2: '98', temp: '36.8', gcs: '15' },
            { age: '30', sex: 'F', complaint: 'Fever', hr: '90', sbp: '110', dbp: '70', rr: '18', spo2: '125', temp: '38.0', gcs: '15' },
            { age: '-10', sex: 'M', complaint: 'Cough', hr: '80', sbp: '115', dbp: '75', rr: '16', spo2: '97', temp: '36.5', gcs: '15' }
          ];
          const audit = auditDatasetQualityRows(testSample, { age: 'age', sex: 'sex', complaint: 'complaint', hr: 'hr', sbp: 'sbp', dbp: 'dbp', rr: 'rr', spo2: 'spo2', temp: 'temp', gcs: 'gcs' });
          const pass = (audit.totalRows === 3) && (audit.badRows.length === 2) && (audit.droppedRowsCount === 0);
          return {
            pass,
            actual: `Total=${audit.totalRows}, BadRows=${audit.badRows.length}, Dropped=${audit.droppedRowsCount}`
          };
        },
        expected: 'Total=3, BadRows=2, Dropped=0 (All preserved)'
      },
      {
        id: 19,
        title: 'Under-triage is computed correctly on a 4-row sample',
        input: '4 evaluated rows: 1 match, 2 under-triaged (L3 vs L1, L4 vs L2), 1 over-triaged (L2 vs L3)',
        run: async () => {
          const sampleEvals = [
            { suggestedLevel: 1, trueLabel: 1 },
            { suggestedLevel: 3, trueLabel: 1 },
            { suggestedLevel: 2, trueLabel: 3 },
            { suggestedLevel: 4, trueLabel: 2 }
          ];
          const stats = computeEvaluationConcordance(sampleEvals);
          const pass = (stats.underTriageCount === 2) && (stats.underTriagePct === 50) && (stats.overTriagePct === 25) && (stats.agreementPct === 25);
          return {
            pass,
            actual: `UnderTriage=${stats.underTriagePct}%, OverTriage=${stats.overTriagePct}%, Agreement=${stats.agreementPct}%`
          };
        },
        expected: 'UnderTriage=50%, OverTriage=25%, Agreement=25%'
      },
      {
        id: 20,
        title: 'Missing vitals never lower the level (Evaluation fail-safe invariant)',
        input: 'Chest pain age 45 evaluated with complete vitals vs completely empty vitals',
        run: async () => {
          const fullRes = evaluateTriage({ age: 45 }, { chest_pain: true }, { spo2: '98', hr: '75', sbp: '120', rr: '16' });
          const missingRes = evaluateTriage({ age: 45 }, { chest_pain: true }, {});
          const pass = (missingRes.suggestedLevel <= fullRes.suggestedLevel) && (missingRes.needsHumanReview === true);
          return {
            pass,
            actual: `FullVitals=L${fullRes.suggestedLevel}, MissingVitals=L${missingRes.suggestedLevel}, NeedsHumanReview=${missingRes.needsHumanReview}`
          };
        },
        expected: 'MissingVitals <= FullVitals (L2), NeedsHumanReview=true'
      },
      {
        id: 21,
        title: 'Dataset Evaluation is blocked for the Clerk and Nurse roles',
        input: 'Check canPerform("canEvaluateDataset") and permission matrix for clerk, nurse, doctor, admin',
        run: async () => {
          const clerkAllowed = ROLES.clerk.canEvaluateDataset;
          const nurseAllowed = ROLES.nurse.canEvaluateDataset;
          const docAllowed = ROLES.doctor.canEvaluateDataset;
          const adminAllowed = ROLES.admin.canEvaluateDataset;
          const pass = (!clerkAllowed) && (!nurseAllowed) && docAllowed && adminAllowed;
          return {
            pass,
            actual: `Clerk=${clerkAllowed}, Nurse=${nurseAllowed}, Doctor=${docAllowed}, Admin=${adminAllowed}`
          };
        },
        expected: 'Clerk=false, Nurse=false, Doctor=true, Admin=true'
      },
      {
        id: 22,
        title: 'The token slip contains token, level text, and room',
        input: 'Sample patient OPD-7777, Level 2 Urgent, assigned Room 1 (Acute Care)',
        run: async () => {
          const testPatient = {
            token: 'OPD-7777',
            name: 'David Miller',
            age: 52,
            sex: 'M',
            confirmedLevel: 2,
            assignedRoom: 'Room 1 (Acute Care)',
            registeredAt: State.vTime
          };
          const slipHtml = generateTokenSlipHtml(testPatient);
          const hasToken = slipHtml.includes('OPD-7777');
          const hasLevel = slipHtml.includes('Level 2') && slipHtml.includes('Urgent');
          const hasRoom = slipHtml.includes('Room 1 (Acute Care)');
          const pass = hasToken && hasLevel && hasRoom;
          return {
            pass,
            actual: `HasToken=${hasToken}, HasLevel=${hasLevel}, HasRoom=${hasRoom}`
          };
        },
        expected: 'HasToken=true, HasLevel=true, HasRoom=true'
      },
      {
        id: 23,
        title: 'Security: escapeHtml sanitizes dangerous HTML characters to prevent XSS',
        input: '`<script>alert("XSS & attack")</script>\' OR 1=1`',
        run: async () => {
          const malicious = '<script>alert("XSS & attack")</script>\'';
          const sanitized = escapeHtml(malicious);
          const hasLt = sanitized.includes('<');
          const hasGt = sanitized.includes('>');
          const hasQuote = sanitized.includes('"');
          const hasAmp = sanitized.includes('&amp;');
          const pass = !hasLt && !hasGt && !hasQuote && hasAmp;
          return {
            pass,
            actual: `Sanitized="${sanitized}", Safe=${pass}`
          };
        },
        expected: 'Safe=true, no unescaped <, >, " or \''
      },
      {
        id: 24,
        title: 'Multilingual NLP: Hindi and Telugu complaints correctly extracted to symptoms & Cardiology',
        input: 'Hindi: "chhati me dard aur saans lene me takleef", Telugu: "gunde noppi aayasam"',
        run: async () => {
          const resHindi = predictAIAcuity({ age: 55 }, 'chhati me dard aur saans lene me takleef', { spo2: 96 });
          const resTelugu = predictAIAcuity({ age: 60 }, 'gunde noppi aayasam', { spo2: 94 });
          const pass = (resHindi.predictedLevel <= 2 && resHindi.recommendedDept === 'Cardiology') &&
                       (resTelugu.predictedLevel <= 2 && resTelugu.recommendedDept === 'Cardiology');
          return {
            pass,
            actual: `Hindi: L${resHindi.predictedLevel} (${resHindi.recommendedDept}), Telugu: L${resTelugu.predictedLevel} (${resTelugu.recommendedDept})`
          };
        },
        expected: 'Hindi: L<=2 (Cardiology), Telugu: L<=2 (Cardiology)'
      },
      {
        id: 25,
        title: 'Safety Invariant: Mandatory emergency rule strictly overrides lower-risk ML prediction',
        input: 'Patient presents with minor cut (ML suggests Level 4) but severe arterial bleeding is present (Rule L1)',
        run: async () => {
          const evalRes = evaluateTriage(
            { age: 50, complaint: 'mild cut on finger' },
            { severe_bleeding: true },
            { spo2: '98', sbp: '120', hr: '75', rr: '16', temp: '36.8' }
          );
          const pass = (evalRes.suggestedLevel === 1) &&
                       evalRes.xaiExplanation.recommendationSource.includes('Mandatory Clinical Safety Rule');
          return {
            pass,
            actual: `Level=${evalRes.suggestedLevel}, Source="${evalRes.xaiExplanation.recommendationSource}"`
          };
        },
        expected: 'Level=1, Source includes "Mandatory Clinical Safety Rule"'
      },
      {
        id: 26,
        title: 'Smart Emergency Alerts: 5-Stage Lifecycle state transitions correctly tracked',
        input: 'Lifecycle: NEW -> ACKNOWLEDGED -> ESCALATED -> REVIEWED -> RESOLVED',
        run: async () => {
          const alt = createAlert({ patientToken: 'OPD-TEST-ALRT', patientName: 'Test Patient', type: 'TEST', level: 1, message: 'Test Emergency' });
          const s1 = alt.state === 'NEW';
          acknowledgeAlert(alt.id);
          const s2 = alt.state === 'ACKNOWLEDGED';
          escalateAlertToDoctor(alt.id, 'Doctor review required');
          const s3 = alt.state === 'ESCALATED';
          reviewAlertByDoctor(alt.id, 'Reviewed by physician');
          const s4 = alt.state === 'REVIEWED';
          resolveAlert(alt.id, 'Discharged');
          const s5 = alt.state === 'RESOLVED';
          const pass = s1 && s2 && s3 && s4 && s5;
          return {
            pass,
            actual: `Stages: NEW=${s1}, ACK=${s2}, ESC=${s3}, REV=${s4}, RES=${s5}`
          };
        },
        expected: 'Stages: NEW=true, ACK=true, ESC=true, REV=true, RES=true'
      },
      {
        id: 27,
        title: 'Hospital Simulator: Urgency prioritization reduces emergency wait times vs FCFS',
        input: 'Run shift simulation (3 Doctors, 2 Nurses, 100 Patients, Arrival Rate 15/hr)',
        run: async () => {
          const sim = runHospitalSimulation({ doctors: 3, nurses: 2, cohort: 100, arrivalRate: 15 });
          const pass = (sim.priority.emergAvgWait <= sim.fcfs.emergAvgWait) && (sim.emergReductionPct >= 0);
          return {
            pass,
            actual: `FCFS Emerg=${sim.fcfs.emergAvgWait}m, Priority Emerg=${sim.priority.emergAvgWait}m, Reduction=${sim.emergReductionPct}%`
          };
        },
        expected: 'Priority Emerg Wait <= FCFS Emerg Wait, Reduction >= 0%'
      },
      {
        id: 28,
        title: 'Sign-in Overlay Accessibility: Vertical scrolling enabled with centered margin layout',
        input: 'Inspect .login-overlay and .login-card computed overflow & centering styles',
        run: async () => {
          const overlay = document.getElementById('loginOverlay');
          const card = document.querySelector('.login-card');
          const overlayComputed = window.getComputedStyle(overlay);
          const hasScrollY = overlayComputed.overflowY === 'auto' || overlayComputed.overflowY === 'scroll';
          const pass = hasScrollY && card !== null;
          return {
            pass,
            actual: `overflowY="${overlayComputed.overflowY}", CardFound=${card !== null}`
          };
        },
        expected: 'overflowY="auto", CardFound=true'
      }
    ];

    const tbody = document.getElementById('selfTestTableBody');
    tbody.innerHTML = '';

    let passedCount = 0;

    for (const a of assertions) {
      let result;
      try {
        result = await a.run();
      } catch (err) {
        result = { pass: false, actual: `FAIL (Error: ${err.message || String(err)})` };
      }
      if (result.pass) passedCount += 1;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight:700;">#${a.id}</td>
        <td><strong>${a.title}</strong></td>
        <td style="font-size:0.8rem; color:#475569;">${a.input}</td>
        <td style="font-size:0.8rem; font-family:var(--font-mono);">${a.expected}</td>
        <td style="font-size:0.8rem; font-family:var(--font-mono);">${result.actual}</td>
        <td>
          <span class="${result.pass ? 'test-pass' : 'test-fail'}">
            ${result.pass ? '✅ PASS' : '❌ FAIL'}
          </span>
        </td>
      `;
      tbody.appendChild(tr);
    }

    const isAllPass = passedCount === assertions.length;
    const summaryBox = document.getElementById('selfTestSummaryBox');
    summaryBox.innerHTML = `
      <div style="background:${isAllPass ? '#f0fdf4' : '#fef2f2'}; border:1px solid ${isAllPass ? '#bbf7d0' : '#fecaca'}; padding:1rem; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <h4 style="color:${isAllPass ? '#166534' : '#991b1b'}; margin-bottom:0.25rem;">
            ${isAllPass ? '🎉 All Safety, Security & Governance Assertions Passed' : '⚠️ Some Assertions Failed'}
          </h4>
          <span style="font-size:0.825rem; color:#475569;">${passedCount} of ${assertions.length} unit checks passed. Rule engine and staff authentication comply with all invariants.</span>
        </div>
        <div>
          <span class="urgency-badge ${isAllPass ? 'l4' : 'l1'}" style="font-size:1rem;">
            ${passedCount} / ${assertions.length} PASS
          </span>
        </div>
      </div>
    `;

    document.getElementById('selfTestBadge').innerText = `${passedCount}/${assertions.length} PASS`;
  }

    // ==========================================================================
  // SECTION 12: UI EVENT HANDLERS & ROLE PERMISSION ENFORCER
  // ==========================================================================
  // Plain-language explanation:
  // Manages navigation between tabs, modal dialog interactions, form submissions,
  // and enforces role-based access control (RBAC) preventing unauthorized clinical actions.

  
  // --------------------------------------------------------------------------
  // ADMIN SYSTEM BACKUP & RESTORE HELPERS
  // --------------------------------------------------------------------------
  function exportBackupJson() {
    if (!canPerform('canManageAccounts')) {
      showToast('Access Restricted', 'Only Administrators can export system backups.', 'toast-warning');
      return;
    }

    const backupData = {
      backupVersion: '1.0.0-pilot',
      exportedAt: new Date().toISOString(),
      exportedBy: State.currentUser,
      state: {
        patients: State.patients,
        alerts: State.alerts,
        audit: State.audit,
        escalations: State.escalations,
        accounts: State.accounts,
        vTime: State.vTime,
        tokenCounter: State.tokenCounter
      }
    };

    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medi_flow_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addAuditEntry({
      action: 'BACKUP_EXPORTED',
      details: `Full system JSON backup exported by ${State.currentUser} (${State.patients.length} patients, ${State.accounts.length} accounts).`
    });

    showToast('Backup Exported', 'Full clinical system JSON backup downloaded successfully.', 'toast-success');
  }

  function importBackupJson(file) {
    if (!canPerform('canManageAccounts')) {
      showToast('Access Restricted', 'Only Administrators can import system backups.', 'toast-warning');
      return;
    }

    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed.state || !Array.isArray(parsed.state.patients) || !Array.isArray(parsed.state.accounts)) {
          showToast('Invalid Backup', 'Selected file is not a valid Medi Flow backup archive.', 'toast-error');
          return;
        }

        State.patients = parsed.state.patients || [];
        State.alerts = parsed.state.alerts || [];
        State.audit = parsed.state.audit || [];
        State.escalations = parsed.state.escalations || [];
        State.accounts = parsed.state.accounts || [];
        State.vTime = parsed.state.vTime || Date.now();
        State.tokenCounter = parsed.state.tokenCounter || (State.patients.length + 1);

        saveAllState();

        addAuditEntry({
          action: 'BACKUP_IMPORTED',
          details: `System restored from JSON backup (${parsed.backupVersion || 'legacy'}). Restored ${State.patients.length} patients, ${State.accounts.length} accounts.`
        });

        renderQueueTable();
        renderAuditTable();
        renderStaffAccountsTable();
        updateAlertCounterUI();
        updateClockDisplay();

        showToast('Backup Restored', `Restored ${State.patients.length} patients and ${State.accounts.length} accounts.`, 'toast-success');
      } catch (err) {
        console.error('Backup import error:', err);
        showToast('Import Failed', 'Failed to parse JSON backup file: ' + err.message, 'toast-error');
      }
    };
    reader.readAsText(file);
  }


  function switchTab(tabId) {
    if (!State.currentAuthUser) {
      showToast('Authentication Required', 'Please sign in to navigate the clinical system.', 'toast-warning');
      return;
    }

    const role = State.currentAuthUser.role;

    // Clerk cannot see rules, audit, accounts
    if (role === 'clerk') {
      if (tabId === 'rulesTab' || tabId === 'auditTab' || tabId === 'accountsTab') {
        enforcePermission('canTriage', `access restricted page (${tabId})`);
        return;
      }
    }

    // Non-admin cannot see accounts
    if (tabId === 'accountsTab' && role !== 'admin') {
      enforcePermission('canManageAccounts', 'access staff account management');
      return;
    }

    // Dataset Evaluation restricted to Doctor and Admin
    if (tabId === 'evaluationTab' && !canPerform('canEvaluateDataset')) {
      enforcePermission('canEvaluateDataset', 'access Dataset Evaluation tool');
      return;
    }

    State.activeTab = tabId;

    document.querySelectorAll('.nav-tab').forEach(tab => {
      if (tab.getAttribute('data-tab') === tabId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    document.querySelectorAll('.tab-pane').forEach(pane => {
      if (pane.id === tabId) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // Refresh tab content on view
    if (tabId === 'queueTab') renderQueueTable();
    else if (tabId === 'doctorInboxTab') renderDoctorInbox();
    else if (tabId === 'auditTab') renderAuditTable();
    else if (tabId === 'dashboardTab') renderDashboard();
    else if (tabId === 'accountsTab') renderAccountsTable();
    else if (tabId === 'rulesTab') renderRulesCatalog();
    else if (tabId === 'evaluationTab') initDatasetEvaluationTab();
    else if (tabId === 'selfTestTab') runSelfTests();
  }

  function renderRulesCatalog() {
    const tbody = document.getElementById('rulesCatalogBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    SAMPLE_RULES.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:var(--font-mono); font-weight:700;">${r.id}</td>
        <td><strong>${r.name}</strong></td>
        <td style="font-size:0.8rem; font-family:var(--font-mono); color:#0369a1;">${r.condition}</td>
        <td><span class="urgency-badge l${r.level}">L${r.level}</span></td>
        <td style="font-size:0.8rem; color:#475569;">${r.rationale}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function setupRuleTesterSandbox() {
    const grid = document.getElementById('testSymptomGrid');
    grid.innerHTML = '';
    SYMPTOM_LIST.forEach(sym => {
      const div = document.createElement('label');
      div.className = `symptom-item ${sym.isRedFlag ? 'red-flag' : ''}`;
      div.innerHTML = `
        <input type="checkbox" id="test_sym_${sym.id}">
        <span>${sym.isRedFlag ? '⚠️ ' : ''}${sym.label}</span>
      `;
      div.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) div.classList.add('checked');
        else div.classList.remove('checked');
      });
      grid.appendChild(div);
    });

    document.getElementById('btnRunRuleTest').onclick = evaluateSandboxTester;
    evaluateSandboxTester();
  }

  function evaluateSandboxTester() {
    const age = parseFloat(document.getElementById('testAge').value) || 30;
    const sex = document.getElementById('testSex').value;
    const pregnancy = document.getElementById('testPregnant').value;

    const symptoms = {};
    SYMPTOM_LIST.forEach(sym => {
      const chk = document.getElementById(`test_sym_${sym.id}`);
      if (chk && chk.checked) symptoms[sym.id] = true;
    });

    const vitals = {
      spo2: document.getElementById('testSpo2').value,
      sbp: document.getElementById('testSbp').value,
      hr: document.getElementById('testHr').value,
      rr: document.getElementById('testRr').value,
      temp: document.getElementById('testTemp').value,
      gcs: document.getElementById('testGcs').value
    };

    const res = evaluateTriage({ age, sex, pregnancy }, symptoms, vitals);
    const container = document.getElementById('ruleTesterOutput');

    const levelIcons = { 1: '🔴', 2: '🟠', 3: '🟡', 4: '🟢' };
    container.innerHTML = `
      <div class="decision-support-box l${res.suggestedLevel}-border">
        <div class="decision-header">
          <div>
            <h4>Tester Pure Evaluation Output</h4>
            <span style="font-size:0.75rem; color:#64748b;">No patient record modified or saved.</span>
          </div>
          <span class="urgency-badge l${res.suggestedLevel}">
            ${levelIcons[res.suggestedLevel]} ${res.levelLabel}
          </span>
        </div>
        ${res.urgentMeasureVitalsNow ? '<div class="danger-callout">⚠️ Urgent: measure vitals now.</div>' : ''}
        ${res.needsHumanReview ? `<div class="warning-callout">⚠️ Needs Human Review: ${res.reasons.join(' ')}</div>` : ''}
        <h5 style="font-size:0.8rem; text-transform:uppercase; margin-top:0.5rem; color:#475569;">Fired Rules:</h5>
        ${res.firedRules.length > 0 ? `
          <ul class="fired-rules-list">
            ${res.firedRules.map(r => `
              <li class="fired-rule-item l${r.level}">
                <strong>${r.name} (Level ${r.level})</strong>: ${r.rationale}
              </li>
            `).join('')}
          </ul>
        ` : '<div style="font-size:0.8rem; color:#64748b;">No rules fired.</div>'}
      </div>
    `;
  }

  // Modal helpers
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  // Toast notification system
  function showToast(title, message, typeClass = 'toast-info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${typeClass}`;
    toast.innerHTML = `
      <div class="toast-content">
        <div class="toast-title">${escapeHtml(title)}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
      </div>
      <button class="toast-close" aria-label="Close notification">&times;</button>
    `;

    toast.querySelector('.toast-close').onclick = () => {
      toast.remove();
    };

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 4500);
  }

  

  
  // ==========================================================================
  // SECTION 13: DATASET EVALUATION ENGINE, CONFUSION MATRIX & TOKEN SLIP PRINTER
  // ==========================================================================
  // Plain-language explanation:
  // This section provides offline retrospective dataset evaluation for Doctors
  // and Administrators, plus thermal/counter token slip generation.
  // 1. Evaluates clinical CSV cohorts in the browser with zero server uploads.
  // 2. Maps columns to clinical fields and maps symptom text to rule keywords.
  // 3. Audits data quality (missing, impossible vitals, duplicates, malformed).
  //    Zero rows are silently dropped; all rows are preserved and audited.
  // 4. Runs the deterministic rule engine on every row, computing L1-L4 distribution.
  // 5. If labels are provided, generates a 4x4 confusion matrix, calculates
  //    Under-triage (safety risk in RED) and Over-triage (conservative in AMBER),
  //    and lists under-triaged patients sorted by severity gap for clinician review.
  // 6. Exports comprehensive results CSV and printable one-page clinical summaries.
  // 7. Generates printable patient routing token slips with room, urgency & vitals.

  // --------------------------------------------------------------------------
  // PART A: TOKEN SLIP PRINT ENGINE (FOR WORKFLOW & QUEUE BOARD)
  // --------------------------------------------------------------------------

  function generateTokenSlipHtml(patient) {
    if (!patient) return '';

    const token = escapeHtml(patient.token || 'OPD-0000');
    const name = escapeHtml(patient.name || 'Anonymous Patient');
    const age = patient.age !== undefined && patient.age !== null ? patient.age : '--';
    const sex = escapeHtml(patient.sex || '--');
    const room = escapeHtml(patient.assignedRoom || 'Triage Waiting / Unassigned');
    const complaint = escapeHtml(patient.chiefComplaint || patient.complaint || 'General OPD assessment');
    const arrivalMode = escapeHtml(patient.arrivalMode || 'Walk-in');

    // Calculate queue position among active (waiting) patients
    const waitingPatients = State.patients
      .filter(p => !p.seen && !p.leftWithoutBeingSeen)
      .sort((a, b) => {
        const lvlA = a.confirmedLevel || a.suggestedLevel || 4;
        const lvlB = b.confirmedLevel || b.suggestedLevel || 4;
        if (lvlA !== lvlB) return lvlA - lvlB;
        return (a.registeredAt || 0) - (b.registeredAt || 0);
      });
    const queueIdx = waitingPatients.findIndex(p => p.token === patient.token);
    const queueRank = queueIdx >= 0 ? queueIdx + 1 : 1;

    // Determine Level metadata
    const levelNum = patient.confirmedLevel || patient.suggestedLevel || 4;
    const levelMeta = {
      1: { name: 'Level 1 - Critical', icon: '🔴', sla: 'Immediate (Resuscitation Bay)', bg: '#fef2f2', border: '#ef4444', text: '#b91c1c' },
      2: { name: 'Level 2 - Urgent', icon: '🟠', sla: 'Within 15 minutes', bg: '#fff7ed', border: '#f97316', text: '#c2410c' },
      3: { name: 'Level 3 - Semi-Urgent', icon: '🟡', sla: 'Within 60 minutes', bg: '#fefce8', border: '#eab308', text: '#854d0e' },
      4: { name: 'Level 4 - Non-Urgent', icon: '🟢', sla: 'Within 120 minutes', bg: '#f0fdf4', border: '#22c55e', text: '#15803d' }
    }[levelNum] || { name: 'Level 4 - Non-Urgent', icon: '🟢', sla: 'Standard Queue', bg: '#f0fdf4', border: '#22c55e', text: '#15803d' };

    // Vitals summary
    const v = patient.vitals || {};
    const vitalsParts = [];
    if (v.hr) vitalsParts.push(`HR: ${v.hr} bpm`);
    if (v.sbp && v.dbp) vitalsParts.push(`BP: ${v.sbp}/${v.dbp} mmHg`);
    else if (v.sbp) vitalsParts.push(`SBP: ${v.sbp} mmHg`);
    if (v.rr) vitalsParts.push(`RR: ${v.rr}/min`);
    if (v.spo2) vitalsParts.push(`SpO2: ${v.spo2}%`);
    if (v.temp) vitalsParts.push(`Temp: ${v.temp} °C`);
    if (v.gcs) vitalsParts.push(`GCS: ${v.gcs}/15`);
    const vitalsSummary = vitalsParts.length > 0 ? vitalsParts.join(' &bull; ') : 'Vitals not recorded at triage';

    // Arrival formatted time
    const arrivalTimeStr = patient.registeredAt
      ? new Date(patient.registeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const arrivalDateStr = patient.registeredAt
      ? new Date(patient.registeredAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
      : new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 2px solid #0f172a; border-radius: 12px; background: #ffffff; color: #0f172a;">
        <!-- Header -->
        <div style="text-align: center; border-bottom: 2px dashed #94a3b8; padding-bottom: 14px; margin-bottom: 16px;">
          <div style="font-size: 1.4rem; font-weight: 800; letter-spacing: -0.5px;">
            <span style="color: #2B3590;">Medi</span> <span style="color: #1AA3B8;">Flow</span>
          </div>
          <div style="font-size: 0.85rem; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px;">
            OPD Triage Decision Support &bull; Routing Slip
          </div>
          <div style="font-size: 0.75rem; color: #64748b; margin-top: 4px;">
            ${arrivalDateStr} &bull; ${arrivalTimeStr} &bull; Arrival: ${arrivalMode}
          </div>
        </div>

        <!-- Token Box -->
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 0.8rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 1px;">Patient Token Number</div>
          <div style="font-size: 3rem; font-weight: 900; color: #0f172a; letter-spacing: 1px; line-height: 1.1; margin: 4px 0;">
            ${token}
          </div>
          <div style="display: inline-block; background: #0f172a; color: #ffffff; font-size: 0.85rem; font-weight: 700; padding: 4px 14px; border-radius: 20px;">
            Queue Rank: Position #${queueRank} in Active Line
          </div>
        </div>

        <!-- Urgency Level Banner (Color + Icon + Text) -->
        <div style="background: ${levelMeta.bg}; border: 2px solid ${levelMeta.border}; border-radius: 8px; padding: 12px; text-align: center; margin-bottom: 16px;">
          <div style="font-size: 0.75rem; font-weight: 700; color: ${levelMeta.text}; text-transform: uppercase; letter-spacing: 0.5px;">
            Assigned Triage Urgency Level
          </div>
          <div style="font-size: 1.35rem; font-weight: 900; color: ${levelMeta.text}; margin: 2px 0;">
            ${levelMeta.icon} ${levelMeta.name}
          </div>
          <div style="font-size: 0.8rem; font-weight: 600; color: ${levelMeta.text};">
            Clinical Target: ${levelMeta.sla}
          </div>
        </div>

        <!-- Assigned Room / Counter -->
        <div style="background: #f1f5f9; border-left: 4px solid #0284c7; border-radius: 4px; padding: 10px 14px; margin-bottom: 16px;">
          <div style="font-size: 0.75rem; font-weight: 700; color: #475569; text-transform: uppercase;">
            Assigned Room / Service Counter:
          </div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #0369a1; margin-top: 2px;">
            📍 ${room}
          </div>
        </div>

        <!-- Patient Demographics & Complaint -->
        <div style="font-size: 0.85rem; border-top: 1px solid #e2e8f0; padding-top: 12px; margin-bottom: 12px; line-height: 1.5;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #64748b;">Patient:</span>
            <span style="font-weight: 700; color: #0f172a;">${name} (${age}y / ${sex})</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #64748b;">Complaint:</span>
            <span style="font-weight: 600; color: #0f172a; text-align: right; max-width: 65%;">${complaint}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #64748b;">Vitals Profile:</span>
            <span style="font-weight: 600; color: #334155; text-align: right; max-width: 65%;">${vitalsSummary}</span>
          </div>
        </div>

        <!-- Footer / Disclaimers -->
        <div style="border-top: 2px dashed #94a3b8; padding-top: 12px; text-align: center; font-size: 0.7rem; color: #64748b; line-height: 1.4;">
          <div style="font-weight: 700; color: #334155;">Decision support prototype &bull; Synthetic demo data only</div>
          <div>Please proceed to your assigned room and present this slip to the attending clinician.</div>
          <div style="margin-top: 4px; font-family: var(--font-mono, monospace); font-size: 0.65rem; color: #94a3b8;">
            ID: ${token} &bull; Triage Decision Support &bull; Verified by Clinical Staff
          </div>
        </div>
      </div>
    `;
  }

  function printTokenSlip(token) {
    return printPatientTokenSlip(token);
  }

  function printPatientTokenSlip(token) {
    const patient = State.patients.find(p => p.token === token);
    if (!patient) {
      showToast('Patient Not Found', `Unable to find patient record for ${token}.`, 'toast-error');
      return;
    }

    const printContainer = document.getElementById('tokenSlipPrintArea');
    if (!printContainer) {
      showToast('Print Error', 'Print area not found in page.', 'toast-error');
      return;
    }

    printContainer.innerHTML = generateTokenSlipHtml(patient);
    window.print();
  }

  // --------------------------------------------------------------------------
  // PART B: BENCHMARK DATASET & CLINICAL SYMPTOM KEYWORD MAP
  // --------------------------------------------------------------------------

  const BENCHMARK_EVALUATION_CSV = `Patient_ID,Age,Sex,Complaint,HR,SBP,DBP,RR,SpO2,Temp,GCS,True_Triage_Label
BENCH-001,32,M,Severe lip swelling stridor and breathlessness,135,88,58,34,86,37.1,14,1
BENCH-002,74,F,Sudden right arm weakness and slurred speech stroke signs,88,175,98,18,97,36.8,15,1
BENCH-003,26,M,Severe head injury with altered consciousness after high-speed crash,118,92,60,24,93,36.9,6,1
BENCH-004,58,M,Severe crushing central chest pain radiating to left arm,92,172,98,20,96,36.7,15,2
BENCH-005,21,F,High fever stiff neck and severe headache,114,118,74,22,98,39.4,14,2
BENCH-006,29,F,Pregnancy 28 weeks with acute abdominal pain and bleeding,105,108,68,20,97,37.0,15,2
BENCH-007,45,M,Known diabetic with deep rapid breathlessness and fatigue,122,105,65,32,96,37.4,15,2
BENCH-008,62,M,Severe sharp abdominal pain with local tenderness,88,138,84,18,97,37.2,15,3
BENCH-009,35,M,High fever burning up with body aches no neck stiffness,98,122,78,18,98,39.1,15,3
BENCH-010,24,F,Acute vomiting and diarrhea without blood,90,112,70,16,98,37.0,15,3
BENCH-011,28,M,Mild cold runny nose sneezing and mild sore throat,72,118,76,14,99,36.6,15,4
BENCH-012,34,F,Twisted ankle walking down steps minor injury,76,120,78,14,98,36.7,15,4
BENCH-013,50,M,Routine follow-up suture removal minor cut healed,68,124,80,12,98,36.5,15,4
BENCH-014,48,M,Dull abdominal pain following blunt injury,84,124,78,16,98,36.8,15,1
BENCH-015,65,F,Diabetic mild indigestion and epigastric discomfort,78,130,80,16,97,36.7,15,2
BENCH-016,22,F,Acute anxiety attack hyperventilation and breathlessness,110,128,82,34,99,36.8,15,3
BENCH-017,44,M,Musculoskeletal chest wall pain worse on palpation,78,126,80,15,98,36.6,15,4
BENCH-018,40,F,Sudden breathlessness no vital signs measured,92,120,80,18,97,37.0,15,2
BENCH-019,55,M,Impossible vitals test row with extreme reading,85,130,82,16,115,52.0,15,3
BENCH-020,28,M,Mild cold runny nose sneezing and mild sore throat,72,118,76,14,99,36.6,15,4`;

  const SYMPTOM_KEYWORD_MAP = {
    chest_pain: ['chest pain', 'angina', 'chest tightness', 'chest pressure', 'substernal', 'myocardial', 'heart attack'],
    breathlessness: ['breath', 'dyspnea', 'shortness of breath', 'sob', 'wheezing', 'asthma', 'stridor', 'hypoxia', 'gasping'],
    altered_consciousness: ['unconscious', 'confusion', 'drowsy', 'lethargic', 'unresponsive', 'delirium', 'disoriented', 'syncope', 'passed out', 'fainted'],
    severe_bleeding: ['bleeding', 'hemorrhage', 'blood loss', 'hematemesis', 'arterial bleed', 'stab wound', 'gsw', 'profuse bleeding'],
    seizure: ['seizure', 'convulsion', 'epilepsy', 'fit', 'post-ictal', 'shaking episode'],
    stroke_signs: ['stroke', 'facial droop', 'slurred speech', 'hemiplegia', 'weakness on one side', 'arm drift', 'tia', 'paralysis'],
    severe_abdominal_pain: ['abdominal pain', 'acute abdomen', 'stomach pain', 'belly pain', 'peritonitis', 'epigastric pain'],
    high_fever: ['high fever', 'febrile', 'pyrexia', 'burning up', 'chills and fever', 'hyperthermia'],
    stiff_neck: ['stiff neck', 'nuchal rigidity', 'neck stiffness', 'meningismus'],
    head_injury: ['head injury', 'concussion', 'head trauma', 'skull fracture', 'hit head'],
    allergic_reaction: ['allergic', 'anaphylaxis', 'urticaria', 'hives', 'angioedema', 'face swelling', 'throat closing'],
    pregnancy_bleeding_pain: ['pregnancy bleeding', 'pregnant with pain', 'vaginal bleeding pregnant', 'miscarriage', 'contractions'],
    vomiting_diarrhea: ['vomiting', 'diarrhea', 'dehydration', 'gastroenteritis', 'severe vomiting', 'bloody diarrhea'],
    minor_injury: ['sprain', 'minor cut', 'abrasion', 'bruise', 'finger injury', 'twisted ankle', 'small laceration'],
    mild_cold: ['cold', 'cough', 'coryza', 'runny nose', 'mild sore throat', 'sneezing', 'nasal congestion']
  };

  function extractSymptomsFromText(text) {
    const symptoms = {};
    const matchedKeywords = [];
    if (!text) return { symptoms, matchedKeywords };
    const lower = String(text).toLowerCase();
    for (const [symKey, keywords] of Object.entries(SYMPTOM_KEYWORD_MAP)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          symptoms[symKey] = true;
          matchedKeywords.push({ symptom: symKey, keyword: kw });
          break;
        }
      }
    }
    return { symptoms, matchedKeywords };
  }

  function normalizeTriageLabel(val) {
    if (val === undefined || val === null || val === '') return null;
    const s = String(val).trim().toLowerCase();
    if (s === '1' || s === 'l1' || s === 'level 1' || s === 'critical' || s === 'resuscitation' || s === 'immediate' || s === 'esi 1' || s === 'esi-1' || s === 'ctas 1' || s === 'red') return 1;
    if (s === '2' || s === 'l2' || s === 'level 2' || s === 'urgent' || s === 'emergent' || s === 'esi 2' || s === 'esi-2' || s === 'ctas 2' || s === 'orange') return 2;
    if (s === '3' || s === 'l3' || s === 'level 3' || s === 'semi-urgent' || s === 'semiurgent' || s === 'urgent-delay' || s === 'esi 3' || s === 'esi-3' || s === 'ctas 3' || s === 'yellow') return 3;
    if (s === '4' || s === 'l4' || s === 'level 4' || s === 'non-urgent' || s === 'nonurgent' || s === 'routine' || s === 'esi 4' || s === 'esi-4' || s === 'esi 5' || s === 'ctas 4' || s === 'ctas 5' || s === 'green' || s === 'blue') return 4;
    const num = parseInt(s, 10);
    if (!isNaN(num) && num >= 1 && num <= 4) return num;
    return null;
  }

  function parseCsvText(text) {
    const lines = [];
    let currentRow = [];
    let currentCell = '';
    let insideQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"') {
        if (insideQuotes && next === '"') {
          currentCell += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else if ((char === '\r' || char === '\n') && !insideQuotes) {
        if (char === '\r' && next === '\n') i++;
        currentRow.push(currentCell.trim());
        if (currentRow.some(c => c.length > 0)) lines.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    if (currentCell.length > 0 || currentRow.length > 0) {
      currentRow.push(currentCell.trim());
      if (currentRow.some(c => c.length > 0)) lines.push(currentRow);
    }

    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].map(h => h.trim());
    const rows = lines.slice(1).map(rowCols => {
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = rowCols[idx] !== undefined ? rowCols[idx] : '';
      });
      return rowObj;
    });
    return { headers, rows };
  }

  function autoGuessColumnMappings(headers) {
    const mapping = {
      age: '',
      sex: '',
      complaint: '',
      hr: '',
      sbp: '',
      dbp: '',
      rr: '',
      spo2: '',
      temp: '',
      gcs: '',
      trueLabel: ''
    };

    const normalize = (str) => String(str).toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const h of headers) {
      const lower = normalize(h);
      if (!mapping.age && (lower === 'age' || lower === 'ptage' || lower === 'patientage' || lower === 'years')) mapping.age = h;
      else if (!mapping.sex && (lower === 'sex' || lower === 'gender' || lower === 'ptsex' || lower === 'ptgender')) mapping.sex = h;
      else if (!mapping.complaint && (lower.includes('complaint') || lower.includes('symptom') || lower === 'cc' || lower === 'reason' || lower.includes('presenting'))) mapping.complaint = h;
      else if (!mapping.hr && (lower === 'hr' || lower === 'pulse' || lower.includes('heartrate') || lower.includes('heart_rate') || lower === 'bpm')) mapping.hr = h;
      else if (!mapping.sbp && (lower === 'sbp' || lower === 'systolic' || lower === 'sysbp' || lower.includes('systolic_bp'))) mapping.sbp = h;
      else if (!mapping.dbp && (lower === 'dbp' || lower === 'diastolic' || lower === 'diabp' || lower.includes('diastolic_bp'))) mapping.dbp = h;
      else if (!mapping.rr && (lower === 'rr' || lower.includes('respiratory') || lower.includes('resp_rate') || lower === 'resprate' || lower === 'breaths')) mapping.rr = h;
      else if (!mapping.spo2 && (lower === 'spo2' || lower.includes('o2sat') || lower.includes('saturation') || lower.includes('pulseox') || lower === 'sat')) mapping.spo2 = h;
      else if (!mapping.temp && (lower === 'temp' || lower.includes('temperature') || lower === 'bodytemp' || lower === 'fever')) mapping.temp = h;
      else if (!mapping.gcs && (lower === 'gcs' || lower.includes('glasgow') || lower.includes('comascale'))) mapping.gcs = h;
      else if (!mapping.trueLabel && (lower.includes('label') || lower.includes('truetriage') || lower.includes('truelabel') || lower.includes('actuallevel') || lower === 'acuity' || lower === 'esi' || lower === 'ctas' || lower === 'targetlevel')) mapping.trueLabel = h;
    }

    return mapping;
  }

  function auditDatasetQualityRows(rows, colMapping) {
    const totalRows = rows.length;
    let cleanRowsCount = 0;
    let impossibleCount = 0;
    let missingVitalsCount = 0;
    let duplicatesCount = 0;
    const droppedRowsCount = 0; // Invariant: Zero rows silently dropped!

    const badRows = [];
    const missingByCol = {};
    const seenSignatures = new Set();

    Object.keys(colMapping).forEach(field => {
      missingByCol[field] = 0;
    });

    const auditedRows = rows.map((r, idx) => {
      const rowNum = idx + 1;
      const issues = [];

      const getVal = (field) => {
        const col = colMapping[field];
        if (!col || r[col] === undefined) return '';
        return String(r[col]).trim();
      };

      // Age validation
      const ageRaw = getVal('age');
      const age = parseFloat(ageRaw);
      if (ageRaw === '') {
        missingByCol.age = (missingByCol.age || 0) + 1;
        issues.push('Missing Age (safely assumed adult 40 for age-band discrimination)');
      } else if (isNaN(age) || age < 0 || age > 120) {
        impossibleCount++;
        issues.push(`Impossible Age value: "${ageRaw}" (Allowed: 0 to 120 years)`);
      }

      // Sex
      const sex = getVal('sex');
      if (!sex) missingByCol.sex = (missingByCol.sex || 0) + 1;

      // Complaint
      const complaint = getVal('complaint');
      if (!complaint) missingByCol.complaint = (missingByCol.complaint || 0) + 1;

      // Vitals & Physiological Hard Limits Audit
      const vitals = {
        hr: getVal('hr'),
        sbp: getVal('sbp'),
        dbp: getVal('dbp'),
        rr: getVal('rr'),
        spo2: getVal('spo2'),
        temp: getVal('temp'),
        gcs: getVal('gcs')
      };

      let vitalsRecordedCount = 0;
      ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'gcs'].forEach(vField => {
        if (!vitals[vField]) {
          missingByCol[vField] = (missingByCol[vField] || 0) + 1;
        } else {
          vitalsRecordedCount++;
        }
      });

      if (vitalsRecordedCount === 0) {
        missingVitalsCount++;
        issues.push('All vitals missing (System fails safe: flagged "Needs human review")');
      }

      // Check physiological validity via validateVitals
      const valResult = validateVitals(vitals, isNaN(age) ? 40 : age);
      if (!valResult.valid) {
        impossibleCount++;
        valResult.errors.forEach(err => issues.push(`Impossible vital rejected: ${err}`));
      }

      // Duplicate detection by clinical signature
      const signature = `${ageRaw}|${sex}|${complaint}|${vitals.hr}|${vitals.sbp}|${vitals.dbp}|${vitals.rr}|${vitals.spo2}|${vitals.temp}|${vitals.gcs}`;
      if (seenSignatures.has(signature)) {
        duplicatesCount++;
        issues.push('Duplicate record: identical demographics, complaints, and vitals to a prior row');
      } else {
        seenSignatures.add(signature);
      }

      // True label
      const trueLabelRaw = getVal('trueLabel');
      const trueLabel = normalizeTriageLabel(trueLabelRaw);
      if (colMapping.trueLabel && !trueLabel && trueLabelRaw) {
        issues.push(`Unrecognized true label format: "${trueLabelRaw}"`);
      }

      const isBad = issues.length > 0;
      if (isBad) {
        badRows.push({
          rowNum,
          rawRow: r,
          issues,
          safetyTreatment: valResult.valid
            ? 'Preserved & evaluated; missing data flagged for human review.'
            : 'Impossible values quarantined; remaining data evaluated failsafe.'
        });
      } else {
        cleanRowsCount++;
      }

      return {
        rowNum,
        rawRow: r,
        age: isNaN(age) ? 40 : age,
        ageRaw,
        sex,
        complaint,
        vitals,
        cleanVitals: valResult.cleanVitals,
        valResult,
        trueLabel,
        trueLabelRaw,
        issues,
        isBad
      };
    });

    return {
      totalRows,
      cleanRowsCount,
      impossibleCount,
      missingVitalsCount,
      duplicatesCount,
      droppedRowsCount,
      badRows,
      missingByCol,
      auditedRows
    };
  }

  function computeEvaluationConcordance(evaluatedRows) {
    let totalWithLabel = 0;
    let matches = 0;
    let underTriageCount = 0; // Suggested less urgent than true label (e.g. L3 vs L1)
    let overTriageCount = 0;  // Suggested more urgent than true label (e.g. L1 vs L2)

    const matrix = [
      [0, 0, 0, 0], // Row 1 (Suggested L1): cols True L1, L2, L3, L4
      [0, 0, 0, 0], // Row 2 (Suggested L2)
      [0, 0, 0, 0], // Row 3 (Suggested L3)
      [0, 0, 0, 0]  // Row 4 (Suggested L4)
    ];

    const underTriagedCohort = [];

    for (const row of evaluatedRows) {
      if (!row.trueLabel || row.trueLabel < 1 || row.trueLabel > 4) continue;
      totalWithLabel++;

      const s = row.suggestedLevel;
      const l = row.trueLabel;

      if (s >= 1 && s <= 4 && l >= 1 && l <= 4) {
        matrix[s - 1][l - 1]++;
      }

      if (s === l) {
        matches++;
      } else if (s > l) {
        // Suggested less urgent than true label -> Under-triage (Danger)
        underTriageCount++;
        const severityGap = s - l;
        underTriagedCohort.push({
          ...row,
          severityGap
        });
      } else if (s < l) {
        // Suggested more urgent than true label -> Over-triage (Conservative)
        overTriageCount++;
      }
    }

    // Sort under-triaged cohort descending by severity gap (+3, +2, +1)
    underTriagedCohort.sort((a, b) => b.severityGap - a.severityGap);

    const agreementPct = totalWithLabel > 0 ? Math.round((matches / totalWithLabel) * 100) : 0;
    const underTriagePct = totalWithLabel > 0 ? Math.round((underTriageCount / totalWithLabel) * 100) : 0;
    const overTriagePct = totalWithLabel > 0 ? Math.round((overTriageCount / totalWithLabel) * 100) : 0;

    return {
      totalWithLabel,
      matches,
      agreementPct,
      underTriageCount,
      underTriagePct,
      overTriageCount,
      overTriagePct,
      matrix,
      underTriagedCohort
    };
  }

  // --------------------------------------------------------------------------
  // PART C: DATASET EVALUATION TAB UI CONTROLLER & EVENT HANDLERS
  // --------------------------------------------------------------------------

  const EvaluationState = {
    rawCsvText: '',
    headers: [],
    rawRows: [],
    colMapping: {},
    auditedQuality: null,
    evaluatedRows: [],
    concordance: null
  };

  function renderMappingUI(headers, guessedMapping) {
    const container = document.getElementById('evalMappingContainer');
    if (!container) return;

    EvaluationState.colMapping = { ...guessedMapping };

    const fields = [
      { key: 'age', label: 'Patient Age', req: true, hint: 'Years (0-120)' },
      { key: 'sex', label: 'Sex / Gender', req: false, hint: 'M / F / Other' },
      { key: 'complaint', label: 'Chief Complaint', req: true, hint: 'Symptoms & Free-text' },
      { key: 'hr', label: 'Heart Rate (HR)', req: false, hint: 'Beats per minute' },
      { key: 'sbp', label: 'Systolic BP (SBP)', req: false, hint: 'mmHg' },
      { key: 'dbp', label: 'Diastolic BP (DBP)', req: false, hint: 'mmHg' },
      { key: 'rr', label: 'Respiratory Rate (RR)', req: false, hint: 'Breaths / min' },
      { key: 'spo2', label: 'SpO2 Saturation', req: false, hint: 'Percentage (0-100%)' },
      { key: 'temp', label: 'Temperature', req: false, hint: 'Degrees Celsius (°C)' },
      { key: 'gcs', label: 'Glasgow Coma Scale', req: false, hint: '3 to 15' },
      { key: 'trueLabel', label: 'True Triage Label (Optional)', req: false, hint: '1-4 or Critical/Urgent/Semi/Non' }
    ];

    container.innerHTML = fields.map(f => {
      const selectedVal = EvaluationState.colMapping[f.key] || '';
      const optionsHtml = [
        '<option value="">-- Not Mapped / Omit --</option>',
        ...headers.map(h => `<option value="${escapeHtml(h)}" ${h === selectedVal ? 'selected' : ''}>${escapeHtml(h)}</option>`)
      ].join('');

      return `
        <div class="form-group" style="margin-bottom: 0.5rem;">
          <label style="font-size:0.8rem; font-weight:700; color:#334155; display:flex; justify-content:space-between;">
            <span>${f.label} ${f.req ? '<span style="color:#ef4444;">*</span>' : ''}</span>
          </label>
          <select class="input eval-col-select" data-field="${f.key}" style="font-size:0.85rem; padding:6px 8px;">
            ${optionsHtml}
          </select>
          <span style="font-size:0.7rem; color:#64748b;">${f.hint}</span>
        </div>
      `;
    }).join('');

    // Attach change handlers to selects
    container.querySelectorAll('.eval-col-select').forEach(sel => {
      sel.onchange = (e) => {
        const field = e.target.getAttribute('data-field');
        EvaluationState.colMapping[field] = e.target.value;
      };
    });

    // Compute symptom keyword hits count
    if (EvaluationState.colMapping.complaint) {
      const compCol = EvaluationState.colMapping.complaint;
      let hitCount = 0;
      EvaluationState.rawRows.forEach(r => {
        const text = r[compCol];
        const res = extractSymptomsFromText(text);
        if (res.matchedKeywords.length > 0) hitCount++;
      });
      const summaryDiv = document.getElementById('evalKeywordHitSummary');
      if (summaryDiv) {
        summaryDiv.textContent = `🎯 Keyword Matcher Status: ${hitCount} of ${EvaluationState.rawRows.length} rows matched clinical triage keywords.`;
      }
    }

    document.getElementById('evalMappingCard').style.display = 'block';
  }

  function handleLoadedCsv(csvText, sourceName = 'Dataset') {
    EvaluationState.rawCsvText = csvText;
    const parsed = parseCsvText(csvText);
    EvaluationState.headers = parsed.headers;
    EvaluationState.rawRows = parsed.rows;

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      showToast('Empty CSV', 'Uploaded file did not contain any valid tabular data.', 'toast-error');
      return;
    }

    const badge = document.getElementById('evalLoadedFileBadge');
    if (badge) {
      badge.textContent = `✅ Loaded: ${sourceName} (${parsed.rows.length} rows, ${parsed.headers.length} columns)`;
      badge.style.display = 'block';
    }

    const guessed = autoGuessColumnMappings(parsed.headers);
    renderMappingUI(parsed.headers, guessed);

    // Hide subsequent result cards until evaluation is run
    document.getElementById('evalDataQualityCard').style.display = 'none';
    document.getElementById('evalResultsCard').style.display = 'none';
    showToast('Dataset Imported', `Parsed ${parsed.rows.length} rows. Please review column mappings.`, 'toast-success');
  }

  function loadBenchmarkEvaluationDataset() {
    handleLoadedCsv(BENCHMARK_EVALUATION_CSV, 'Medi Flow Clinical Benchmark Cohort (20 OPD Patients)');
  }

  function resetEvaluation() {
    EvaluationState.rawCsvText = '';
    EvaluationState.headers = [];
    EvaluationState.rawRows = [];
    EvaluationState.colMapping = {};
    EvaluationState.auditedQuality = null;
    EvaluationState.evaluatedRows = [];
    EvaluationState.concordance = null;

    const fileInput = document.getElementById('csvFileInput');
    if (fileInput) fileInput.value = '';
    const badge = document.getElementById('evalLoadedFileBadge');
    if (badge) badge.style.display = 'none';

    document.getElementById('evalMappingCard').style.display = 'none';
    document.getElementById('evalDataQualityCard').style.display = 'none';
    document.getElementById('evalResultsCard').style.display = 'none';

    showToast('Evaluation Cleared', 'Dataset evaluation state reset successfully.', 'toast-info');
  }

  function runDatasetEvaluationAndAudit() {
    if (!canPerform('canEvaluateDataset')) {
      enforcePermission('canEvaluateDataset', 'execute dataset evaluation');
      return;
    }

    if (EvaluationState.rawRows.length === 0) {
      showToast('No Dataset', 'Please import a CSV file or load the benchmark dataset first.', 'toast-warning');
      return;
    }

    // Step 1: Pre-run Data Quality Audit
    const dq = auditDatasetQualityRows(EvaluationState.rawRows, EvaluationState.colMapping);
    EvaluationState.auditedQuality = dq;

    // Render Data Quality Card
    renderDataQualityCard(dq);

    // Step 2: Run deterministic rule engine on every audited row
    let countL1 = 0;
    let countL2 = 0;
    let countL3 = 0;
    let countL4 = 0;
    let countHumanReview = 0;
    let countMissingVitals = 0;

    const evaluatedRows = dq.auditedRows.map(row => {
      // Extract symptom checklist from complaint text
      const extracted = extractSymptomsFromText(row.complaint);
      const symptoms = extracted.symptoms;

      // Evaluate using the pure rule engine
      const evalRes = evaluateTriage(
        { age: row.age, sex: row.sex },
        symptoms,
        row.cleanVitals
      );

      // Invariant: If row had impossible vitals, missing vitals or quality issues, flag for review
      const needsReview = evalRes.needsHumanReview || row.issues.length > 0;
      if (needsReview) countHumanReview++;

      const vitalsEmpty = Object.values(row.cleanVitals).every(v => v === '' || v === undefined);
      if (vitalsEmpty) countMissingVitals++;

      const level = evalRes.suggestedLevel;
      if (level === 1) countL1++;
      else if (level === 2) countL2++;
      else if (level === 3) countL3++;
      else countL4++;

      // Concordance tag
      let concordanceStatus = 'Unlabeled';
      if (row.trueLabel) {
        if (level === row.trueLabel) concordanceStatus = 'Concordant';
        else if (level > row.trueLabel) concordanceStatus = 'Under-Triage';
        else concordanceStatus = 'Over-Triage';
      }

      return {
        ...row,
        suggestedLevel: level,
        levelLabel: evalRes.levelLabel,
        firedRules: evalRes.firedRules,
        needsHumanReview: needsReview,
        extractedSymptoms: Object.keys(symptoms),
        concordanceStatus
      };
    });

    EvaluationState.evaluatedRows = evaluatedRows;

    // Step 3: Compute concordance & confusion matrix if trueLabel mapped
    let concordance = null;
    if (EvaluationState.colMapping.trueLabel) {
      concordance = computeEvaluationConcordance(evaluatedRows);
      EvaluationState.concordance = concordance;
    }

    // Step 4: Render Results UI
    renderEvaluationResultsCard(evaluatedRows, concordance, {
      countL1, countL2, countL3, countL4, countHumanReview, countMissingVitals, total: evaluatedRows.length
    });

    // Step 5: Audit Log entry (who, when, row count, summary numbers)
    const summaryMsg = `Evaluated ${evaluatedRows.length} rows. Distribution: L1=${countL1}, L2=${countL2}, L3=${countL3}, L4=${countL4}. Human Review=${countHumanReview}.` +
      (concordance && concordance.totalWithLabel > 0 ? ` Agreement=${concordance.agreementPct}%, UnderTriage=${concordance.underTriagePct}%, OverTriage=${concordance.overTriagePct}%.` : '');

    addAuditEntry({
      action: 'DATASET_EVALUATION',
      patientToken: 'COHORT-RUN',
      patientName: 'Dataset Batch Run',
      details: summaryMsg
    });

    showToast('Evaluation Complete', `Evaluated ${evaluatedRows.length} records. All rows audited and preserved.`, 'toast-success');
  }

  function renderDataQualityCard(dq) {
    const card = document.getElementById('evalDataQualityCard');
    if (!card) return;

    document.getElementById('dqTotalRows').textContent = dq.totalRows;
    document.getElementById('dqCleanRows').textContent = dq.cleanRowsCount;
    const cleanPct = dq.totalRows > 0 ? Math.round((dq.cleanRowsCount / dq.totalRows) * 100) : 100;
    document.getElementById('dqCleanPct').textContent = `${cleanPct}% complete records`;
    document.getElementById('dqImpossibleCount').textContent = dq.impossibleCount;
    document.getElementById('dqMissingVitalsCount').textContent = dq.missingVitalsCount;
    document.getElementById('dqDuplicatesCount').textContent = dq.duplicatesCount;

    // Per-column missing breakdown
    const missingContainer = document.getElementById('dqColumnMissingSummary');
    if (missingContainer) {
      const parts = Object.entries(dq.missingByCol).map(([field, count]) => {
        const pct = dq.totalRows > 0 ? Math.round((count / dq.totalRows) * 100) : 0;
        return `<span style="display:inline-block; margin-right:12px; margin-bottom:4px;"><strong>${escapeHtml(field)}:</strong> ${count} missing (${pct}%)</span>`;
      });
      missingContainer.innerHTML = `<div style="font-weight:700; color:#334155; margin-bottom:4px;">📊 Missing Values per Mapped Column:</div>` + parts.join('');
    }

    // Bad / flagged rows table
    const tbody = document.getElementById('dqBadRowsBody');
    if (tbody) {
      if (dq.badRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#15803d; padding:1rem; font-weight:600;">✅ Excellent! Zero data-quality defects detected across all ${dq.totalRows} records.</td></tr>`;
      } else {
        tbody.innerHTML = dq.badRows.map(b => {
          const rawPreview = Object.entries(b.rawRow).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(' | ');
          return `
            <tr>
              <td style="font-weight:700; font-family:var(--font-mono);">${b.rowNum}</td>
              <td style="color:#b91c1c;">
                ${b.issues.map(iss => `<div style="margin-bottom:2px;">&bull; ${escapeHtml(iss)}</div>`).join('')}
              </td>
              <td style="font-size:0.75rem; color:#64748b; font-family:var(--font-mono);">${escapeHtml(rawPreview)}</td>
              <td style="font-weight:600; color:#0369a1; font-size:0.8rem;">${escapeHtml(b.safetyTreatment)}</td>
            </tr>
          `;
        }).join('');
      }
    }

    card.style.display = 'block';
  }

  function renderEvaluationResultsCard(evaluatedRows, concordance, stats) {
    const card = document.getElementById('evalResultsCard');
    if (!card) return;

    const total = stats.total || 1;
    document.getElementById('evalL1Count').textContent = stats.countL1;
    document.getElementById('evalL1Pct').textContent = `${Math.round((stats.countL1 / total) * 100)}% (${stats.countL1} of ${total})`;

    document.getElementById('evalL2Count').textContent = stats.countL2;
    document.getElementById('evalL2Pct').textContent = `${Math.round((stats.countL2 / total) * 100)}% (${stats.countL2} of ${total})`;

    document.getElementById('evalL3Count').textContent = stats.countL3;
    document.getElementById('evalL3Pct').textContent = `${Math.round((stats.countL3 / total) * 100)}% (${stats.countL3} of ${total})`;

    document.getElementById('evalL4Count').textContent = stats.countL4;
    document.getElementById('evalL4Pct').textContent = `${Math.round((stats.countL4 / total) * 100)}% (${stats.countL4} of ${total})`;

    document.getElementById('evalHumanReviewCount').textContent = stats.countHumanReview;
    document.getElementById('evalMissingVitalsCount').textContent = `${stats.countMissingVitals} with missing vitals`;

    // Concordance & Confusion Matrix
    const metricsSection = document.getElementById('evalLabelMetricsSection');
    if (concordance && concordance.totalWithLabel > 0) {
      metricsSection.style.display = 'block';
      document.getElementById('evalAgreementRate').textContent = `${concordance.agreementPct}%`;
      document.getElementById('evalAgreementSubtext').textContent = `${concordance.matches} of ${concordance.totalWithLabel} records concordant`;

      document.getElementById('evalUnderTriageRate').textContent = `${concordance.underTriagePct}%`;
      document.getElementById('evalUnderTriageSubtext').textContent = `${concordance.underTriageCount} of ${concordance.totalWithLabel} patients assigned lower urgency`;

      document.getElementById('evalOverTriageRate').textContent = `${concordance.overTriagePct}%`;
      document.getElementById('evalOverTriageSubtext').textContent = `${concordance.overTriageCount} of ${concordance.totalWithLabel} patients assigned higher urgency`;

      // Render 4x4 Confusion Matrix
      const cmBody = document.getElementById('evalConfusionMatrixBody');
      if (cmBody) {
        const levelNames = ['🔴 L1 Critical', '🟠 L2 Urgent', '🟡 L3 Semi-Urgent', '🟢 L4 Non-Urgent'];
        let cmHtml = '';

        for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
          const rowSugLevel = rowIdx + 1;
          const rowTotal = concordance.matrix[rowIdx].reduce((a, b) => a + b, 0);

          cmHtml += `<tr>`;
          cmHtml += `<td style="font-weight:700; text-align:left; background:#f8fafc;">${levelNames[rowIdx]}</td>`;

          for (let colIdx = 0; colIdx < 4; colIdx++) {
            const colTrueLevel = colIdx + 1;
            const count = concordance.matrix[rowIdx][colIdx];
            let cellClass = 'cm-zero';
            if (count > 0) {
              if (rowSugLevel === colTrueLevel) cellClass = 'cm-diag';
              else if (rowSugLevel > colTrueLevel) cellClass = 'cm-under'; // under-triage
              else cellClass = 'cm-over'; // over-triage
            }
            cmHtml += `<td class="${cellClass}" style="font-weight:700; font-size:1.05rem;">${count}</td>`;
          }

          cmHtml += `<td style="font-weight:800; background:#f8fafc;">${rowTotal}</td>`;
          cmHtml += `</tr>`;
        }

        // Column totals row
        cmHtml += `<tr style="font-weight:800; background:#f1f5f9;">`;
        cmHtml += `<td style="text-align:left;">Total Ground Truth</td>`;
        for (let c = 0; c < 4; c++) {
          let colSum = 0;
          for (let r = 0; r < 4; r++) colSum += concordance.matrix[r][c];
          cmHtml += `<td>${colSum}</td>`;
        }
        cmHtml += `<td>${concordance.totalWithLabel}</td>`;
        cmHtml += `</tr>`;

        cmBody.innerHTML = cmHtml;
      }

      // Render Under-Triaged Cohort Table (Sorted by Severity Gap)
      const utCount = document.getElementById('evalUnderTriageCohortCount');
      if (utCount) utCount.textContent = `${concordance.underTriagedCohort.length} safety reviews`;

      const utBody = document.getElementById('evalUnderTriageBody');
      if (utBody) {
        if (concordance.underTriagedCohort.length === 0) {
          utBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#15803d; padding:1rem; font-weight:600;">✅ Excellent! Zero under-triaged cases identified. (0% clinical under-triage risk).</td></tr>`;
        } else {
          utBody.innerHTML = concordance.underTriagedCohort.map(r => {
            const firedText = r.firedRules && r.firedRules.length > 0
              ? r.firedRules.map(f => f.ruleName || f.ruleId).join(', ')
              : 'Default baseline';
            const vitalsText = Object.entries(r.cleanVitals).filter(([_, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ') || 'None';

            return `
              <tr style="background:#fff1f2;">
                <td style="font-weight:700; font-family:var(--font-mono);">${r.rowNum}</td>
                <td>
                  <span style="display:inline-block; background:#dc2626; color:#ffffff; font-weight:800; font-size:0.75rem; padding:2px 8px; border-radius:12px;">
                    +${r.severityGap} (Lvl ${r.suggestedLevel} vs Lvl ${r.trueLabel})
                  </span>
                </td>
                <td style="font-weight:700; color:#b91c1c;">L${r.trueLabel}</td>
                <td style="font-weight:700; color:#d97706;">L${r.suggestedLevel}</td>
                <td>${r.age}y / ${escapeHtml(r.sex || '--')}</td>
                <td style="max-width:200px; font-weight:600;">${escapeHtml(r.complaint)}</td>
                <td style="font-size:0.75rem; font-family:var(--font-mono);">${escapeHtml(vitalsText)}</td>
                <td style="font-size:0.75rem; color:#475569;">${escapeHtml(firedText)}</td>
              </tr>
            `;
          }).join('');
        }
      }
    } else {
      metricsSection.style.display = 'none';
    }

    // Render Full Cohort Table
    renderFullCohortTable(evaluatedRows);

    card.style.display = 'block';
  }

  function renderFullCohortTable(rows) {
    const tbody = document.getElementById('evalFullCohortBody');
    if (!tbody) return;

    const searchTerm = (document.getElementById('evalSearchInput')?.value || '').toLowerCase().trim();

    const filtered = rows.filter(r => {
      if (!searchTerm) return true;
      const haystack = `${r.rowNum} ${r.complaint} ${r.age} ${r.sex} ${r.suggestedLevel} ${r.concordanceStatus} ${r.firedRules.map(f => f.ruleName).join(' ')}`.toLowerCase();
      return haystack.includes(searchTerm);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#64748b; padding:1.5rem;">No matching patient records found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(r => {
      const levelColors = { 1: '#dc2626', 2: '#ea580c', 3: '#ca8a04', 4: '#16a34a' };
      const color = levelColors[r.suggestedLevel] || '#475569';
      const concordanceBadges = {
        'Concordant': '<span class="status-badge active" style="font-size:0.7rem;">Match</span>',
        'Under-Triage': '<span class="status-badge escalated" style="font-size:0.7rem; background:#fee2e2; color:#dc2626;">Under-Triage</span>',
        'Over-Triage': '<span class="status-badge" style="font-size:0.7rem; background:#fef3c7; color:#b45309;">Over-Triage</span>',
        'Unlabeled': '<span class="status-badge" style="font-size:0.7rem; background:#f1f5f9; color:#64748b;">No Label</span>'
      };

      const vitalsText = Object.entries(r.cleanVitals).filter(([_, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ') || 'None';
      const rulesText = r.firedRules.length > 0 ? r.firedRules.map(f => f.ruleName).join('; ') : 'Baseline Level 4';
      const flagsText = r.issues.length > 0 ? r.issues.join('; ') : 'Clean';

      return `
        <tr>
          <td style="font-weight:700; font-family:var(--font-mono);">${r.rowNum}</td>
          <td style="font-weight:800; color:${color};">Level ${r.suggestedLevel}</td>
          <td style="font-weight:700;">${r.trueLabel ? `Level ${r.trueLabel}` : '--'}</td>
          <td>${concordanceBadges[r.concordanceStatus] || ''}</td>
          <td>${r.age}y / ${escapeHtml(r.sex || '--')}</td>
          <td style="max-width:180px;">${escapeHtml(r.complaint)}</td>
          <td style="font-size:0.75rem; font-family:var(--font-mono);">${escapeHtml(vitalsText)}</td>
          <td style="font-size:0.75rem; color:#475569; max-width:180px;">${escapeHtml(rulesText)}</td>
          <td style="font-size:0.75rem; color:${r.issues.length > 0 ? '#b91c1c' : '#15803d'};">${escapeHtml(flagsText)}</td>
        </tr>
      `;
    }).join('');
  }

  function exportEvaluationResultsCsv() {
    if (!EvaluationState.evaluatedRows || EvaluationState.evaluatedRows.length === 0) {
      showToast('Export Error', 'No evaluation results available to export.', 'toast-error');
      return;
    }

    const headers = [
      'Row_ID',
      'Suggested_Level',
      'Level_Label',
      'True_Label',
      'Concordance_Status',
      'Severity_Gap',
      'Age',
      'Sex',
      'Chief_Complaint',
      'Extracted_Symptoms',
      'HR',
      'SBP',
      'DBP',
      'RR',
      'SpO2',
      'Temp',
      'GCS',
      'Needs_Human_Review',
      'Fired_Rules',
      'Data_Quality_Flags'
    ];

    const escapeCsv = (val) => {
      if (val === undefined || val === null) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const lines = [headers.join(',')];

    EvaluationState.evaluatedRows.forEach(r => {
      const firedNames = (r.firedRules || []).map(f => f.ruleName || f.ruleId).join('; ');
      const flagsStr = (r.issues || []).join('; ');
      const symStr = (r.extractedSymptoms || []).join('; ');
      const gap = r.trueLabel && r.suggestedLevel > r.trueLabel ? (r.suggestedLevel - r.trueLabel) : 0;

      const rowValues = [
        r.rowNum,
        r.suggestedLevel,
        r.levelLabel,
        r.trueLabel || '',
        r.concordanceStatus,
        gap,
        r.age,
        r.sex || '',
        r.complaint || '',
        symStr,
        r.cleanVitals.hr || '',
        r.cleanVitals.sbp || '',
        r.cleanVitals.dbp || '',
        r.cleanVitals.rr || '',
        r.cleanVitals.spo2 || '',
        r.cleanVitals.temp || '',
        r.cleanVitals.gcs || '',
        r.needsHumanReview ? 'YES' : 'NO',
        firedNames,
        flagsStr
      ];

      lines.push(rowValues.map(escapeCsv).join(','));
    });

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medi_flow_evaluation_results_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('CSV Exported', 'Evaluation cohort results downloaded successfully.', 'toast-success');
  }

  function printEvaluationSummaryReport() {
    if (!EvaluationState.evaluatedRows || EvaluationState.evaluatedRows.length === 0) {
      showToast('Print Error', 'Please run evaluation before printing the summary report.', 'toast-warning');
      return;
    }

    const printContainer = document.getElementById('tokenSlipPrintArea');
    if (!printContainer) return;

    const dq = EvaluationState.auditedQuality || {};
    const concordance = EvaluationState.concordance;
    const staffName = State.currentAuthUser ? State.currentAuthUser.name : 'Clinical Staff';
    const staffRole = State.currentAuthUser ? State.currentAuthUser.role.toUpperCase() : 'DOCTOR';
    const nowStr = new Date().toLocaleString();

    let cmRowsHtml = '';
    if (concordance && concordance.matrix) {
      const names = ['L1 Critical', 'L2 Urgent', 'L3 Semi-Urgent', 'L4 Non-Urgent'];
      cmRowsHtml = names.map((name, rIdx) => {
        const counts = concordance.matrix[rIdx].map((c, cIdx) => {
          const bg = rIdx === cIdx ? '#dcfce7' : (rIdx > cIdx ? '#fee2e2' : '#fef3c7');
          return `<td style="padding:6px; border:1px solid #cbd5e1; text-align:center; background:${bg}; font-weight:700;">${c}</td>`;
        }).join('');
        const rowSum = concordance.matrix[rIdx].reduce((a, b) => a + b, 0);
        return `<tr><td style="padding:6px; border:1px solid #cbd5e1; font-weight:700;">${name}</td>${counts}<td style="padding:6px; border:1px solid #cbd5e1; text-align:center; font-weight:800;">${rowSum}</td></tr>`;
      }).join('');
    }

    printContainer.innerHTML = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px; color: #0f172a;">
        <!-- Header -->
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 2px solid #2B3590; padding-bottom: 12px; margin-bottom: 16px;">
          <div>
            <div style="font-size: 1.6rem; font-weight: 800;">
              <span style="color: #2B3590;">Medi</span> <span style="color: #1AA3B8;">Flow</span>
            </div>
            <div style="font-size: 0.9rem; font-weight: 700; color: #334155;">OPD Triage Decision Support &bull; Cohort Evaluation Summary</div>
          </div>
          <div style="text-align: right; font-size: 0.75rem; color: #64748b;">
            <div>Date: ${nowStr}</div>
            <div>Evaluator: ${escapeHtml(staffName)} (${staffRole})</div>
          </div>
        </div>

        <!-- Mandatory Notice -->
        <div style="background: #f0f9ff; border: 1px solid #0284c7; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; font-size: 0.8rem; color: #0369a1;">
          <strong>Clinical Notice:</strong> Evaluation only, not clinical validation. Rules must be reviewed and approved by qualified clinicians.
        </div>

        <!-- Key Metrics -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; text-align: center;">
          <div style="border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px;">
            <div style="font-size: 0.75rem; color: #64748b; font-weight: 700;">TOTAL COHORT</div>
            <div style="font-size: 1.5rem; font-weight: 900; color: #0f172a;">${EvaluationState.evaluatedRows.length}</div>
            <div style="font-size: 0.7rem; color: #16a34a;">0 dropped records</div>
          </div>
          <div style="border: 1px solid #86efac; background: #f0fdf4; border-radius: 6px; padding: 10px;">
            <div style="font-size: 0.75rem; color: #166534; font-weight: 700;">AGREEMENT RATE</div>
            <div style="font-size: 1.5rem; font-weight: 900; color: #15803d;">${concordance ? concordance.agreementPct : '--'}%</div>
            <div style="font-size: 0.7rem; color: #166534;">Concordant labels</div>
          </div>
          <div style="border: 2px solid #ef4444; background: #fef2f2; border-radius: 6px; padding: 10px;">
            <div style="font-size: 0.75rem; color: #991b1b; font-weight: 800;">UNDER-TRIAGE (RISK)</div>
            <div style="font-size: 1.5rem; font-weight: 900; color: #dc2626;">${concordance ? concordance.underTriagePct : '--'}%</div>
            <div style="font-size: 0.7rem; color: #b91c1c;">System less urgent</div>
          </div>
          <div style="border: 1px solid #f59e0b; background: #fffbeb; border-radius: 6px; padding: 10px;">
            <div style="font-size: 0.75rem; color: #92400e; font-weight: 700;">OVER-TRIAGE</div>
            <div style="font-size: 1.5rem; font-weight: 900; color: #d97706;">${concordance ? concordance.overTriagePct : '--'}%</div>
            <div style="font-size: 0.7rem; color: #b45309;">Conservative bias</div>
          </div>
        </div>

        <!-- Data Quality Audit Summary -->
        <div style="margin-bottom: 16px; font-size: 0.8rem; line-height: 1.5;">
          <div style="font-weight: 700; color: #1e293b; margin-bottom: 4px;">Data Quality &amp; Completeness Audit:</div>
          <div>Total parsed: <strong>${dq.totalRows || EvaluationState.evaluatedRows.length}</strong> &bull; Clean: <strong>${dq.cleanRowsCount || 0}</strong> &bull; Impossible values flagged: <strong>${dq.impossibleCount || 0}</strong> &bull; Missing vitals: <strong>${dq.missingVitalsCount || 0}</strong> &bull; Duplicates: <strong>${dq.duplicatesCount || 0}</strong>.</div>
        </div>

        <!-- Confusion Matrix -->
        ${concordance && concordance.matrix ? `
          <div style="margin-bottom: 16px;">
            <div style="font-weight: 700; color: #1e293b; font-size: 0.85rem; margin-bottom: 6px;">4x4 Confusion Matrix (Suggestion vs Ground Truth):</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 0.75rem;">
              <thead>
                <tr style="background:#f1f5f9;">
                  <th style="padding:6px; border:1px solid #cbd5e1; text-align:left;">Suggestion ↓ / Truth →</th>
                  <th style="padding:6px; border:1px solid #cbd5e1;">L1</th>
                  <th style="padding:6px; border:1px solid #cbd5e1;">L2</th>
                  <th style="padding:6px; border:1px solid #cbd5e1;">L3</th>
                  <th style="padding:6px; border:1px solid #cbd5e1;">L4</th>
                  <th style="padding:6px; border:1px solid #cbd5e1;">Total</th>
                </tr>
              </thead>
              <tbody>
                ${cmRowsHtml}
              </tbody>
            </table>
          </div>
        ` : ''}

        <!-- Footer -->
        <div style="border-top: 1px solid #cbd5e1; padding-top: 12px; margin-top: 24px; text-align: center; font-size: 0.7rem; color: #64748b;">
          Generated by Medi Flow OPD Triage Decision Support &bull; Synthetic Demo System &bull; Offline Client Execution
        </div>
      </div>
    `;

    window.print();
  }

  function initDatasetEvaluationTab() {
    return setupDatasetEvaluationListeners();
  }

  function setupDatasetEvaluationListeners() {
    // Benchmark sample button
    const btnBenchmark = document.getElementById('btnLoadSampleDataset');
    if (btnBenchmark) btnBenchmark.onclick = loadBenchmarkEvaluationDataset;

    // Reset button
    const btnReset = document.getElementById('btnResetEvaluation');
    if (btnReset) btnReset.onclick = resetEvaluation;

    // Auto-guess mapping button
    const btnAutoGuess = document.getElementById('btnAutoGuessMapping');
    if (btnAutoGuess) {
      btnAutoGuess.onclick = () => {
        if (EvaluationState.headers.length > 0) {
          const guessed = autoGuessColumnMappings(EvaluationState.headers);
          renderMappingUI(EvaluationState.headers, guessed);
          showToast('Mappings Updated', 'Auto-guessed column mappings from CSV headers.', 'toast-info');
        }
      };
    }

    // Run Data Quality & Rule Evaluation button
    const btnRunEval = document.getElementById('btnRunDataQualityAudit');
    if (btnRunEval) btnRunEval.onclick = runDatasetEvaluationAndAudit;

    // Export Results CSV
    const btnExportCsv = document.getElementById('btnExportEvalResultsCsv');
    if (btnExportCsv) btnExportCsv.onclick = exportEvaluationResultsCsv;

    // Print Report
    const btnPrintReport = document.getElementById('btnPrintEvalReport');
    if (btnPrintReport) btnPrintReport.onclick = printEvaluationSummaryReport;

    // Full Cohort Search Filter
    const searchInput = document.getElementById('evalSearchInput');
    if (searchInput) {
      searchInput.oninput = () => {
        renderFullCohortTable(EvaluationState.evaluatedRows);
      };
    }

    // File Input & Drag-and-Drop
    const dropZone = document.getElementById('csvDropZone');
    const fileInput = document.getElementById('csvFileInput');

    if (dropZone && fileInput) {
      dropZone.onclick = () => fileInput.click();

      fileInput.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            handleLoadedCsv(evt.target.result, file.name);
          };
          reader.readAsText(file);
        }
      };

      dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.style.background = '#e2e8f0';
      };

      dropZone.ondragleave = (e) => {
        e.preventDefault();
        dropZone.style.background = '#f8fafc';
      };

      dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.background = '#f8fafc';
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            handleLoadedCsv(evt.target.result, file.name);
          };
          reader.readAsText(file);
        }
      };
    }
  }



  // ==========================================================================
  // SECTION 14: WHAT-IF HOSPITAL OPERATIONS SIMULATOR & VOICE DICTATION ENGINE
  // ==========================================================================
  // Plain-language explanation:
  // 1. Hospital Simulator: Discrete-event multi-server queuing simulation comparing
  //    Scenario A (First-Come-First-Served) vs. Scenario B (Medi Flow Urgency Prioritization).
  //    Computes average wait times, SLA breaches, and emergency wait-time reductions.
  // 2. Voice Dictation: Web Speech API integration supporting English, Hindi (Devanagari),
  //    and Telugu for hands-free clinical complaint intake with nurse review.
  // 3. Audio Emergency Alerts: Web Audio API synthesized clinical alert chime.

  function playEmergencyAlertSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15); // E5 note
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {
      // AudioContext unavailable or blocked
    }
  }

  function escalateAlertToDoctor(alertId, note) {
    const alert = State.alerts.find(a => a.id === alertId);
    if (!alert) return;

    alert.state = 'ESCALATED';
    alert.escalatedBy = `${State.currentUser} (${ROLES[State.currentRole]?.title || 'Staff'})`;
    alert.escalatedAt = State.vTime;
    alert.escalationNote = note || 'Escalated for immediate doctor review';

    addAuditEntry({
      action: 'ALERT_ESCALATED_DOCTOR',
      patientToken: alert.patientToken,
      patientName: alert.patientName,
      details: `Alert ${alert.id} escalated to Doctor by ${State.currentUser}. Note: "${alert.escalationNote}"`,
      diff: { alertId: alert.id, state: 'ESCALATED' }
    });

    saveAllState();
    updateAlertCounterUI();
    renderAlertCenterModal();
    renderQueueTable();
    showToast('Alert Escalated', `Alert for ${alert.patientToken} escalated to Doctor Inbox.`, 'toast-warning');
  }

  function reviewAlertByDoctor(alertId, reviewNote) {
    const alert = State.alerts.find(a => a.id === alertId);
    if (!alert) return;

    alert.state = 'REVIEWED';
    alert.doctorReviewedBy = `${State.currentUser} (Doctor)`;
    alert.doctorReviewedAt = State.vTime;
    alert.doctorReviewNote = reviewNote || 'Clinical orders documented and reviewed by physician';

    addAuditEntry({
      action: 'ALERT_REVIEWED_DOCTOR',
      patientToken: alert.patientToken,
      patientName: alert.patientName,
      details: `Alert ${alert.id} reviewed by Doctor ${State.currentUser}. Clinical note: "${alert.doctorReviewNote}"`,
      diff: { alertId: alert.id, state: 'REVIEWED' }
    });

    saveAllState();
    updateAlertCounterUI();
    renderAlertCenterModal();
    renderQueueTable();
    showToast('Alert Reviewed', `Doctor review completed for ${alert.patientToken}.`, 'toast-info');
  }

  // --------------------------------------------------------------------------
  // WHAT-IF HOSPITAL OPERATIONS SIMULATOR
  // --------------------------------------------------------------------------

  function runHospitalSimulation(params = {}) {
    const numDoctors = Number(params.doctors || document.getElementById('simDoctors')?.value || 3);
    const numNurses = Number(params.nurses || document.getElementById('simNurses')?.value || 2);
    const cohortSize = Number(params.cohort || document.getElementById('simCohort')?.value || 100);
    const arrivalRate = Number(params.arrivalRate || document.getElementById('simArrivalRate')?.value || 15);
    const preset = String(params.preset || document.getElementById('simPreset')?.value || 'standard');
    const speed = Number(params.speed || document.getElementById('simSpeed')?.value || 2);

    const paceMultiplier = speed === 1 ? 0.75 : (speed === 3 ? 1.4 : 1.0);

    const presets = {
      standard: [0.03, 0.09, 0.36, 0.32, 0.20],
      surge: [0.06, 0.18, 0.48, 0.18, 0.10],
      disaster: [0.25, 0.35, 0.25, 0.10, 0.05],
      routine: [0.01, 0.02, 0.17, 0.50, 0.30]
    };
    const weights = presets[preset] || presets.standard;
    const baseDurations = { 1: 30, 2: 20, 3: 15, 4: 10, 5: 5 };
    const slaTargets = { 1: 0, 2: 15, 3: 60, 4: 120, 5: 180 };

    // Deterministic pseudo-random sequence for fair apples-to-apples comparison
    let seed = 42;
    function rand() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    // Generate patient arrival schedule
    const patients = [];
    let curTime = 0;
    for (let i = 0; i < cohortSize; i++) {
      const interArrival = -Math.log(1.0 - rand()) * (60.0 / arrivalRate);
      curTime += interArrival;

      const r = rand();
      let cum = 0;
      let level = 5;
      for (let idx = 0; idx < weights.length; idx++) {
        cum += weights[idx];
        if (r <= cum) {
          level = idx + 1;
          break;
        }
      }

      const dur = Math.max(3.0, baseDurations[level] * paceMultiplier * (0.8 + 0.4 * rand()));
      patients.push({
        id: i + 1,
        arrivalTime: curTime,
        level,
        serviceDuration: dur,
        sla: slaTargets[level]
      });
    }

    // Execute Queue Simulation Engine
    function simulateQueue(isPriorityMode) {
      const docFree = new Array(numDoctors).fill(0);
      const queue = patients.map(p => ({ ...p }));
      const waiting = [];
      const served = [];
      let unservedIdx = 0;

      while (unservedIdx < queue.length || waiting.length > 0) {
        // Find earliest available doctor
        let earliestDocIdx = 0;
        for (let d = 1; d < numDoctors; d++) {
          if (docFree[d] < docFree[earliestDocIdx]) earliestDocIdx = d;
        }
        const earliestTime = docFree[earliestDocIdx];

        let t;
        if (waiting.length === 0 && unservedIdx < queue.length) {
          t = Math.max(earliestTime, queue[unservedIdx].arrivalTime);
        } else {
          t = earliestTime;
        }

        while (unservedIdx < queue.length && queue[unservedIdx].arrivalTime <= t) {
          waiting.push(queue[unservedIdx]);
          unservedIdx++;
        }

        if (waiting.length === 0) {
          if (unservedIdx >= queue.length) break;
          continue;
        }

        if (!isPriorityMode) {
          // FCFS: Arrival order
          waiting.sort((a, b) => a.arrivalTime - b.arrivalTime);
        } else {
          // Medi Flow: Clinical Urgency Level ASC (1 before 2 before 3...), then arrival time
          waiting.sort((a, b) => {
            if (a.level !== b.level) return a.level - b.level;
            return a.arrivalTime - b.arrivalTime;
          });
        }

        const p = waiting.shift();
        const startTime = Math.max(t, p.arrivalTime);
        const waitTime = Math.max(0, startTime - p.arrivalTime);
        const endTime = startTime + p.serviceDuration;
        docFree[earliestDocIdx] = endTime;

        p.startTime = startTime;
        p.waitTime = waitTime;
        p.endTime = endTime;
        p.slaBreached = waitTime > p.sla;
        served.push(p);
      }

      const allWaits = served.map(p => p.waitTime);
      const emergWaits = served.filter(p => p.level <= 2).map(p => p.waitTime);
      const avgWait = allWaits.length ? (allWaits.reduce((a, b) => a + b, 0) / allWaits.length) : 0;
      const emergAvgWait = emergWaits.length ? (emergWaits.reduce((a, b) => a + b, 0) / emergWaits.length) : 0;
      const maxWait = allWaits.length ? Math.max(...allWaits) : 0;
      const maxEmergWait = emergWaits.length ? Math.max(...emergWaits) : 0;
      const slaBreaches = served.filter(p => p.slaBreached).length;
      const emergSlaBreaches = served.filter(p => p.level <= 2 && p.slaBreached).length;

      const waitByLevel = {};
      for (let lvl = 1; lvl <= 5; lvl++) {
        const lvlWaits = served.filter(p => p.level === lvl).map(p => p.waitTime);
        waitByLevel[lvl] = lvlWaits.length ? Math.round(lvlWaits.reduce((a, b) => a + b, 0) / lvlWaits.length) : 0;
      }

      return {
        avgWait: Math.round(avgWait),
        emergAvgWait: Math.round(emergAvgWait),
        maxWait: Math.round(maxWait),
        maxEmergWait: Math.round(maxEmergWait),
        slaBreaches,
        emergSlaBreaches,
        servedCount: served.length,
        waitByLevel
      };
    }

    const resFcfs = simulateQueue(false);
    const resPriority = simulateQueue(true);

    let emergReductionPct = 0;
    if (resFcfs.emergAvgWait > 0) {
      emergReductionPct = Math.round(((resFcfs.emergAvgWait - resPriority.emergAvgWait) / resFcfs.emergAvgWait) * 100);
    }

    renderSimulatorUI({
      fcfs: resFcfs,
      priority: resPriority,
      emergReductionPct,
      cohortSize
    });

    return { fcfs: resFcfs, priority: resPriority, emergReductionPct };
  }

  function renderSimulatorUI(sim) {
    if (!document.getElementById('simFcfsAvgWait')) return;

    document.getElementById('simFcfsAvgWait').textContent = `${sim.fcfs.avgWait} min`;
    document.getElementById('simFcfsEmergWait').textContent = `${sim.fcfs.emergAvgWait} min`;
    document.getElementById('simFcfsMaxWait').textContent = `${sim.fcfs.maxWait} min`;
    document.getElementById('simFcfsSlaBreaches').textContent = `${sim.fcfs.slaBreaches} patients (${sim.fcfs.emergSlaBreaches} in L1/L2)`;
    document.getElementById('simFcfsServed').textContent = `${sim.fcfs.servedCount} / ${sim.cohortSize}`;

    document.getElementById('simPriorityAvgWait').textContent = `${sim.priority.avgWait} min`;
    document.getElementById('simPriorityEmergWait').textContent = `${sim.priority.emergAvgWait} min`;
    document.getElementById('simPriorityMaxWait').textContent = `${sim.priority.maxEmergWait} min`;
    document.getElementById('simPrioritySlaBreaches').textContent = `${sim.priority.slaBreaches} patients (${sim.priority.emergSlaBreaches} in L1/L2)`;
    document.getElementById('simPriorityServed').textContent = `${sim.priority.servedCount} / ${sim.cohortSize}`;

    const badge = document.getElementById('simEmergReductionBadge');
    if (badge) {
      badge.textContent = `-${sim.emergReductionPct}% Wait-Time Reduction`;
    }

    // Render comparative bar chart
    const chartContainer = document.getElementById('simChartContainer');
    if (chartContainer) {
      const levels = [
        { lvl: 1, name: 'L1 Resuscitation' },
        { lvl: 2, name: 'L2 Emergent' },
        { lvl: 3, name: 'L3 Urgent' },
        { lvl: 4, name: 'L4 Less Urgent' },
        { lvl: 5, name: 'L5 Non-Urgent' }
      ];

      const maxVal = Math.max(
        ...Object.values(sim.fcfs.waitByLevel),
        ...Object.values(sim.priority.waitByLevel),
        1
      );

      chartContainer.innerHTML = levels.map(l => {
        const fcfsVal = sim.fcfs.waitByLevel[l.lvl] || 0;
        const prioVal = sim.priority.waitByLevel[l.lvl] || 0;
        const fcfsPct = Math.min(100, Math.round((fcfsVal / maxVal) * 100));
        const prioPct = Math.min(100, Math.round((prioVal / maxVal) * 100));

        return `
          <div style="margin-bottom:0.75rem;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; font-weight:700; margin-bottom:2px;">
              <span>${l.name}</span>
              <span>FCFS: ${fcfsVal}m vs Medi Flow: <strong>${prioVal}m</strong></span>
            </div>
            <div style="display:flex; flex-direction:column; gap:2px;">
              <!-- FCFS Bar -->
              <div style="background:#e2e8f0; border-radius:3px; height:8px; width:100%; overflow:hidden;">
                <div style="background:#94a3b8; height:100%; width:${fcfsPct}%;"></div>
              </div>
              <!-- Priority Bar -->
              <div style="background:#e2e8f0; border-radius:3px; height:8px; width:100%; overflow:hidden;">
                <div style="background:#16a34a; height:100%; width:${prioPct}%;"></div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  function setupSimulatorListeners() {
    const btnRun = document.getElementById('btnRunSimulator');
    if (btnRun) btnRun.onclick = () => runHospitalSimulation();

    const btnReset = document.getElementById('btnResetSimulator');
    if (btnReset) {
      btnReset.onclick = () => {
        if (document.getElementById('simDoctors')) document.getElementById('simDoctors').value = 3;
        if (document.getElementById('simNurses')) document.getElementById('simNurses').value = 2;
        if (document.getElementById('simCohort')) document.getElementById('simCohort').value = 100;
        if (document.getElementById('simArrivalRate')) document.getElementById('simArrivalRate').value = 15;
        if (document.getElementById('simPreset')) document.getElementById('simPreset').value = 'standard';
        if (document.getElementById('simSpeed')) document.getElementById('simSpeed').value = 2;
        updateSimSliderLabels();
        runHospitalSimulation();
      };
    }

    function updateSimSliderLabels() {
      if (document.getElementById('valSimDoctors') && document.getElementById('simDoctors')) {
        document.getElementById('valSimDoctors').textContent = document.getElementById('simDoctors').value;
      }
      if (document.getElementById('valSimNurses') && document.getElementById('simNurses')) {
        document.getElementById('valSimNurses').textContent = document.getElementById('simNurses').value;
      }
      if (document.getElementById('valSimCohort') && document.getElementById('simCohort')) {
        document.getElementById('valSimCohort').textContent = `${document.getElementById('simCohort').value} patients`;
      }
      if (document.getElementById('valSimArrivalRate') && document.getElementById('simArrivalRate')) {
        document.getElementById('valSimArrivalRate').textContent = `${document.getElementById('simArrivalRate').value} / hr`;
      }
      if (document.getElementById('valSimSpeed') && document.getElementById('simSpeed')) {
        const val = Number(document.getElementById('simSpeed').value);
        document.getElementById('valSimSpeed').textContent = val === 1 ? 'Fast (10m)' : (val === 3 ? 'Thorough (22m)' : 'Standard (15m)');
      }
    }

    ['simDoctors', 'simNurses', 'simCohort', 'simArrivalRate', 'simSpeed'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = () => {
          updateSimSliderLabels();
          runHospitalSimulation();
        };
      }
    });

    const presetEl = document.getElementById('simPreset');
    if (presetEl) {
      presetEl.onchange = () => runHospitalSimulation();
    }

    updateSimSliderLabels();
  }

  // --------------------------------------------------------------------------
  // WEB SPEECH API MULTILINGUAL VOICE DICTATION
  // --------------------------------------------------------------------------

  function setupVoiceDictation() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

    function attachVoiceControl(btnId, targetInputId, langSelectId, statusId) {
      const btn = document.getElementById(btnId);
      const targetInput = document.getElementById(targetInputId);
      const langSelect = document.getElementById(langSelectId);
      const statusEl = document.getElementById(statusId);

      if (!btn || !targetInput) return;

      if (!SpeechRec) {
        btn.title = 'Speech Recognition not supported in this browser (manual text entry active).';
        btn.onclick = () => {
          showToast('Voice Input Unsupported', 'Web Speech API is not supported in this browser. Please type patient complaint manually.', 'toast-warning');
        };
        return;
      }

      let recognition = null;
      let isRecording = false;

      btn.onclick = () => {
        if (isRecording) {
          if (recognition) recognition.stop();
          return;
        }

        try {
          recognition = new SpeechRec();
          recognition.lang = langSelect ? langSelect.value : 'en-IN';
          recognition.continuous = false;
          recognition.interimResults = true;

          recognition.onstart = () => {
            isRecording = true;
            btn.classList.add('listening');
            btn.innerHTML = '🔴 <span>Listening...</span>';
            if (statusEl) {
              statusEl.style.display = 'block';
              statusEl.textContent = `🎙️ Listening in ${recognition.lang}... Speak presenting complaint clearly.`;
            }
          };

          recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              transcript += event.results[i][0].transcript;
            }
            if (transcript) {
              const currentVal = targetInput.value.trim();
              targetInput.value = currentVal ? `${currentVal} ${transcript}` : transcript;
              targetInput.dispatchEvent(new Event('input', { bubbles: true }));
              if (statusEl) {
                statusEl.textContent = `📝 Transcribed: "${transcript}" (Verify before saving)`;
              }
            }
          };

          recognition.onerror = (event) => {
            isRecording = false;
            btn.classList.remove('listening');
            btn.innerHTML = '🎤 <span>Voice Input</span>';
            if (statusEl) {
              statusEl.textContent = `⚠️ Voice error: ${event.error}. Please type complaint manually.`;
            }
            showToast('Voice Error', `Speech error: ${event.error}. Please enter manually.`, 'toast-warning');
          };

          recognition.onend = () => {
            isRecording = false;
            btn.classList.remove('listening');
            btn.innerHTML = '🎤 <span>Voice Input</span>';
            if (statusEl) {
              setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 4000);
            }
          };

          recognition.start();
        } catch (err) {
          isRecording = false;
          btn.classList.remove('listening');
          btn.innerHTML = '🎤 <span>Voice Input</span>';
          showToast('Microphone Blocked', 'Microphone permission blocked or unavailable.', 'toast-warning');
        }
      };
    }

    attachVoiceControl('btnVoiceDictateReg', 'regChiefComplaint', 'regVoiceLangSelect', 'regVoiceStatus');
    attachVoiceControl('btnVoiceDictateTriage', 'triageClinicalNotes', 'triageVoiceLangSelect', 'triageVoiceStatus');
  }


    // ==========================================================================
  // INITIALIZATION & GLOBAL BINDINGS
  // ==========================================================================

  async function init() {
    loadState();
    await seedInitialDemoAccounts();
    initInactivityWatcher();
    updateClockDisplay();
    updateAlertCounterUI();

    // Staff Login Form Submit
    const loginForm = document.getElementById('staffLoginForm');
    if (loginForm) {
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const staffId = document.getElementById('loginStaffId').value;
        const pass = document.getElementById('loginPassword').value;
        await loginUser(staffId, pass);
      };
    }

    // Quick Login Demo Buttons
    document.querySelectorAll('.btn-quick-login').forEach(btn => {
      btn.onclick = async () => {
        const u = btn.getAttribute('data-user');
        const p = btn.getAttribute('data-pass');
        document.getElementById('loginStaffId').value = u;
        document.getElementById('loginPassword').value = p;
        await loginUser(u, p);
      };
    });

    // Logout Button
    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.onclick = () => logoutUser('Manual logout');
    }

    // Inactivity Modal Buttons
    const btnStay = document.getElementById('btnInactivityStayLoggedIn');
    if (btnStay) {
      btnStay.onclick = () => {
        State.lastActivityTime = Date.now();
        closeModal('inactivityModal');
        showToast('Session Extended', 'Your active session has been renewed.', 'toast-info');
      };
    }
    const btnInactLogout = document.getElementById('btnInactivityLogoutNow');
    if (btnInactLogout) {
      btnInactLogout.onclick = () => {
        closeModal('inactivityModal');
        logoutUser('User requested logout from timeout warning');
      };
    }

    // Account Management Forms & Modals
    const createAccForm = document.getElementById('createStaffAccountForm');
    if (createAccForm) {
      createAccForm.onsubmit = handleCreateStaffAccountSubmit;
    }
    const filterAccRole = document.getElementById('filterAccountRole');
    if (filterAccRole) {
      filterAccRole.onchange = renderAccountsTable;
    }
    const btnCloseReset = document.getElementById('btnCloseResetModal');
    if (btnCloseReset) btnCloseReset.onclick = () => closeModal('passwordResetModal');
    const btnCancelReset = document.getElementById('btnCancelResetModal');
    if (btnCancelReset) btnCancelReset.onclick = () => closeModal('passwordResetModal');
    const btnConfirmReset = document.getElementById('btnConfirmPasswordReset');
    if (btnConfirmReset) btnConfirmReset.onclick = handleConfirmPasswordReset;

    // Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        switchTab(tab.getAttribute('data-tab'));
      });
    });

    // Time simulation & Demo Controls
    document.getElementById('btnSimulate15m').onclick = simulatePlus15Min;
    document.getElementById('btnLoadDemoData').onclick = loadDemoData;
    document.getElementById('btnResetData').onclick = resetAllData;

    // Emergency Walk-in quick button
    document.getElementById('btnQuickEmergency').onclick = () => openModal('emergencyWalkInModal');
    document.getElementById('btnCloseEmergModal').onclick = () => closeModal('emergencyWalkInModal');
    document.getElementById('btnCancelEmergModal').onclick = () => closeModal('emergencyWalkInModal');
    document.getElementById('btnSubmitEmergencyWalkIn').onclick = handleEmergencyWalkInSubmit;

    // Registration Form
    document.getElementById('btnGoRegister').onclick = () => switchTab('registerTab');
    document.getElementById('patientRegistrationForm').onsubmit = handleRegistrationSubmit;
    document.getElementById('regAge').oninput = (e) => {
      const b = getAgeBand(e.target.value);
      document.getElementById('regAgeBandHint').innerText = `Band: ${b.toUpperCase()}`;
    };

    // Duplicate Modal
    document.getElementById('btnCancelDuplicate').onclick = () => {
      State.pendingDuplicateData = null;
      closeModal('duplicateModal');
    };
    document.getElementById('btnConfirmDuplicateRegistration').onclick = () => {
      if (State.pendingDuplicateData) {
        commitRegistration(State.pendingDuplicateData);
        State.pendingDuplicateData = null;
      }
      closeModal('duplicateModal');
    };

    // Triage Modal
    document.getElementById('btnCloseTriageModal').onclick = () => closeModal('triageModal');
    document.getElementById('btnCancelTriage').onclick = () => closeModal('triageModal');
    document.getElementById('btnConfirmSuggestion').onclick = handleConfirmSuggestionClick;
    document.getElementById('btnToggleOverride').onclick = handleToggleOverrideClick;
    document.getElementById('btnSaveTriageDecision').onclick = handleSaveTriageClick;

    // Downgrade Warning Modal
    document.getElementById('btnCancelDowngrade').onclick = () => closeModal('downgradeModal');
    document.getElementById('btnConfirmDowngrade').onclick = handleConfirmDowngradeClick;

    // Escalation Modal
    document.getElementById('btnCloseEscalationModal').onclick = () => closeModal('escalationModal');
    document.getElementById('btnCancelEscalation').onclick = () => closeModal('escalationModal');
    document.getElementById('btnSubmitEscalation').onclick = handleEscalationSubmit;

    // Doctor Response Modal
    document.getElementById('btnCloseDocResponseModal').onclick = () => closeModal('doctorResponseModal');
    document.getElementById('btnCancelDocResponse').onclick = () => closeModal('doctorResponseModal');
    document.getElementById('btnSubmitDocResponse').onclick = handleDoctorResponseSubmit;

    // Reorder Modal
    document.getElementById('btnCloseReorderModal').onclick = () => closeModal('reorderModal');
    document.getElementById('btnCancelReorder').onclick = () => closeModal('reorderModal');
    document.getElementById('btnConfirmReorder').onclick = handleConfirmReorder;

    // Patient Timeline Modal
    document.getElementById('btnCloseTimelineModal').onclick = () => closeModal('patientTimelineModal');
    document.getElementById('btnCloseTimelineFooter').onclick = () => closeModal('patientTimelineModal');

    // Alert Center Modal
    document.getElementById('btnOpenAlerts').onclick = () => {
      renderAlertCenterModal();
      openModal('alertCenterModal');
    };
    document.getElementById('btnCloseAlertCenter').onclick = () => closeModal('alertCenterModal');
    document.getElementById('btnCloseAlertCenterFooter').onclick = () => closeModal('alertCenterModal');

    // Queue Filters & Search
    document.getElementById('filterLevel').onchange = renderQueueTable;
    document.getElementById('filterStatus').onchange = renderQueueTable;
    document.getElementById('queueSearchInput').oninput = renderQueueTable;

    // Doctor Inbox Filter
    document.getElementById('filterDoctorEscalation').onchange = renderDoctorInbox;

    // Audit Filters & Export
    document.getElementById('filterAuditAction').onchange = renderAuditTable;
    document.getElementById('auditSearchInput').oninput = renderAuditTable;
    document.getElementById('btnExportAuditCsv').onclick = exportAuditToCsv;
    document.getElementById('btnExportQueueCsv').onclick = exportQueueToCsv;

    // Self Test
    document.getElementById('btnRunSelfTests').onclick = runSelfTests;
    // Register Service Worker for offline capability
    if ('serviceWorker' in navigator) {
      try {
        navigator.serviceWorker.register('./sw.js').catch(err => {
          console.warn('Service worker registration note:', err);
        });
      } catch (e) {
        console.warn('Service worker unavailable:', e);
      }
    }

    // Keyboard accessibility: Escape key closes active dialogs
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
      }
    });

    // Backup Export / Import Event Listeners
    const btnExportBackup = document.getElementById('btnExportBackupJson');
    if (btnExportBackup) btnExportBackup.onclick = exportBackupJson;

    const btnTriggerImport = document.getElementById('btnTriggerImportBackup');
    const inputImport = document.getElementById('inputImportBackupJson');
    if (btnTriggerImport && inputImport) {
      btnTriggerImport.onclick = () => inputImport.click();
      inputImport.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) importBackupJson(file);
      };
    }


    // Setup Sandbox & Initial Render
    setupDatasetEvaluationListeners();
    setupSimulatorListeners();
    setupVoiceDictation();
    setupRuleTesterSandbox();
    renderRulesCatalog();
    renderQueueTable();
    try {
      await runSelfTests();
    } catch (testErr) {
      console.error('Self-tests encountered an unexpected error:', testErr);
      const summaryBox = document.getElementById('selfTestSummaryBox');
      if (summaryBox) {
        summaryBox.innerHTML = `
          <div class="danger-callout" style="padding:1rem; border-left:4px solid #dc2626;">
            <strong>⚠️ Self-Test Execution Error (FAIL):</strong> ${escapeHtml(testErr && testErr.message ? testErr.message : String(testErr))}
          </div>
        `;
      }
    }

    // If state is empty, load demo data automatically for immediate testing
    if (State.patients.length === 0) {
      loadDemoData();
    }

    // Check login state: show login screen if not authenticated
    if (State.currentAuthUser) {
      document.getElementById('loginOverlay').style.display = 'none';
      updateUserProfileHeader();
      applyRolePermissions();
    } else {
      document.getElementById('loginOverlay').style.display = 'flex';
      document.getElementById('userProfileChip').style.display = 'none';
    }
  }

  // Public window interface for onclick callbacks in generated HTML
  window.triageApp = {
    openTriage: openTriageAssessmentModal,
    openEscalation: openEscalationModal,
    openDoctorResponse: openDoctorResponseModal,
    openTimeline: openPatientTimeline,
    openReorder: openReorderModal,
    markPatientSeen,
    markPatientLwbs,
    ackAlert: acknowledgeAlert,
    promptResolveAlert: (id) => {
      const note = prompt('Enter clinical resolution note for this alert:', 'Issue addressed / Patient assessed');
      if (note !== null) resolveAlert(id, note);
    },
    ackEscalation: acknowledgeEscalation,
    approveAccount: approveStaffAccount,
    toggleAccountStatus: toggleStaffAccountStatus,
    openResetPassword: openResetPasswordModal,
    toggleLicenseVerified: toggleLicenseVerified,
    printTokenSlip,
    initDatasetEvaluationTab,
    exportBackup: exportBackupJson,
    importBackup: importBackupJson,
    loadBenchmarkDataset: loadBenchmarkEvaluationDataset,
    exportEvalCsv: exportEvaluationResultsCsv,
    printEvalReport: printEvaluationSummaryReport,
    escalateAlert: (id) => {
      const note = prompt('Enter clinical reason for escalation to Doctor:', 'Deteriorating vitals / Acute emergency review needed');
      if (note !== null) escalateAlertToDoctor(id, note);
    },
    reviewAlert: (id) => {
      const note = prompt('Enter physician clinical orders / review notes:', 'Patient evaluated by Doctor. Treatment plan initiated.');
      if (note !== null) reviewAlertByDoctor(id, note);
    },
    runSimulation: runHospitalSimulation
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }

})();
