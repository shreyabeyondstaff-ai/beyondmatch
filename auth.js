/* =========================================================
   AUTH.JS
   Login, signup, logout, and the global session listener that
   redirects users to the right dashboard. Firebase instances
   and constants come from config.js; the one backend call this
   file needs (candidate/recruiter registration, and the
   DynamoDB self-heal lookup) goes through api.js.
========================================================= */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  validatePassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { logEvent } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import {
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { auth, db, analytics } from "./config.js";
import { registerCandidate, registerRecruiter, getRecruiterByUid } from "./api.js";
import { parseResumeFile, inferRoleFromResume, showToast, logError, clearGeocodeCache } from "./utils.js";

// Prevents redirect while signup Firestore writes are still in-flight
let _signupInProgress = false;

/* =========================================================
   RESOLVE-TO-BACKEND-ID
   Resolves a "local_<uid>" placeholder candidate ID (written
   when signup couldn't reach the backend in time) to a real
   backend candidate_id. Migrates the Firestore doc to the new
   ID and cleans up the placeholder. Used by candidate.js
   whenever match-loading needs a resolvable candidate_id.
========================================================= */
export async function resolveToBackendId(localId) {
  if (!localId.startsWith("local_")) return localId;

  const snap = await getDoc(doc(db, "candidates", localId));
  if (!snap.exists()) return localId;

  const data = snap.data();
  const resumeText = data.resume_text || "";
  if (!resumeText.trim()) return localId; // nothing to register without a resume

  const backendId = await registerCandidate({
    name: data.name || data.email?.split("@")[0] || "candidate",
    email: data.email,
    resume_text: resumeText
  }, 8000);

  if (!backendId) return localId;

  const user = auth.currentUser;
  await setDoc(doc(db, "candidates", backendId), { ...data, candidate_id: backendId, is_latest: true, createdAt: serverTimestamp() });
  if (user) {
    await setDoc(doc(db, "users", user.uid), { candidate_id: backendId, latest_candidate_id: backendId }, { merge: true });
  }
  try { await deleteDoc(doc(db, "candidates", localId)); } catch { /* best-effort cleanup */ }

  return backendId;
}

/* =========================================================
   GLOBAL AUTH STATE LISTENER
   Handles redirects, token expiry warnings, and missing
   candidate_id / recruiter_id backfills for existing accounts.

   IMPORTANT: everything after the Firestore read is wrapped in
   try/catch. Previously an uncaught error here (e.g. a bare
   `uid` reference, or a Firestore permission error) would throw
   inside this async callback and silently kill the redirect —
   no error dialog, just nothing happening after login/signup.
========================================================= */
onAuthStateChanged(auth, async (user) => {
  const path = window.location.pathname;

  if (!user) {
    // SEC-10: signed out (this tab, another tab, expiry or revocation):
    // nothing from the previous session may stay in the tab.
    clearSessionState();
    if (!path.endsWith("index.html") && path !== "/") {
      window.location.href = "/index.html";
    }
    return;
  }

  // Warn when the session token is about to expire (only on non-index pages)
  if (!path.endsWith("index.html") && path !== "/") {
    try {
      const tokenResult = await user.getIdTokenResult();
      const minsLeft = (new Date(tokenResult.expirationTime) - new Date()) / 60000;
      if (minsLeft < 5 && window.showToast) {
        showToast("Session expiring soon — please save your work.", "warning");
      }
    } catch { /* non-critical — ignore */ }
    return;
  }

  // Wait for any in-progress signup Firestore writes before redirecting
  if (_signupInProgress) {
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!_signupInProgress) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 30000); // was 5000 — was cutting off slow signup writes
    });
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const userData = snap.exists() ? snap.data() : {};

    // SEC-01: the authoritative role is the server-issued custom claim
    // (set only via the Firebase Admin SDK). users/{uid}.role is a legacy,
    // routing-only fallback for accounts that have no claim yet and can
    // never grant admin.
    const { claims } = await user.getIdTokenResult();
    const storedRole = snap.exists() ? userData.role : "candidate";
    const role = claims.role || (storedRole === "admin" ? undefined : storedRole);

    // Safety net: candidate signed up but candidate_id was never written
    if (role === "candidate" && !userData.candidate_id) {
      const fallbackId = `local_${user.uid}`;
      try {
        const existingCand = await getDoc(doc(db, "candidates", fallbackId));
        if (!existingCand.exists()) {
          await setDoc(doc(db, "candidates", fallbackId), {
            candidate_id: fallbackId,
            name:         user.email.split("@")[0],
            email:        user.email,
            user_id:      user.uid,
            applied_role: "candidate",
            resume_text:  "",
            is_latest:    true,
            createdAt:    serverTimestamp()
          });
        }
        await setDoc(doc(db, "users", user.uid), {
          candidate_id:        fallbackId,
          latest_candidate_id: fallbackId
        }, { merge: true });
      } catch (backfillErr) {
        logError("candidate profile backfill failed", backfillErr);
        /* best-effort backfill — don't block redirect on this */
      }
    }

    let target;

    if (role === "recruiter") {
      // Backfill recruiter_id for accounts created before this field existed
      if (!userData.recruiter_id) {
        try {
          await updateDoc(doc(db, "users", user.uid), { recruiter_id: user.uid });
        } catch (e) {
          logError("recruiter id backfill failed", e);
        }
      }
      target = "/rec-dash.html";
    } else if (role === "admin") {
      target = "/admin.html";
    } else if (!role) {
      // SELF-HEAL: role is completely missing from this doc — the exact
      // signature left by the old signup race condition, which wrote
      // candidate_id fields but never got to write `role` before the
      // page navigated away. A genuine candidate ALWAYS has
      // role:"candidate" explicitly written, so `!role` only ever
      // matches these corrupted accounts. Check DynamoDB — if this uid
      // is a real recruiter there, repair Firestore and route correctly,
      // automatically, with no manual fix needed per account.
      // `role` itself is not written here: Firestore rules make it
      // immutable from the client (SEC-01); the recruiter custom claim is
      // issued server-side.
      const recruiter = await getRecruiterByUid(user.uid);
      if (recruiter) {
        await setDoc(doc(db, "users", user.uid), {
          email:               recruiter.email || user.email,
          organisation_name:   recruiter.organisation_name || null,
          recruiter_id:        user.uid,
          candidate_id:        null,
          latest_candidate_id: null
        }, { merge: true });
        target = "/rec-dash.html";
      }

      // Self-heal found nothing — this really is a candidate whose doc
      // is incomplete (e.g. signup was interrupted). Fall back as before.
      if (!target) target = "/candidate-dashboard.html";
    } else {
      target = "/candidate-dashboard.html";
    }

    window.location.href = target;

  } catch (err) {
    logError("sign-in redirect failed", err);
    if (window.showToast) {
      showToast("Login succeeded but redirect failed. Please try refreshing the page.", "error");
    }
  }
});


/* =========================================================
   FIND LEADS ACCESS — single source of truth
   Eligibility comes from server-issued custom claims
   (role: "recruiter" + findLeads: true), not a hard-coded UID,
   so rec-leads.html's own access gate (in recruiter.js) uses
   the exact same rule.
========================================================= */
window._isBeyondMatchRecruiter = async function (user) {
  if (!user) return false;
  const { claims } = await user.getIdTokenResult();
  return claims.role === "recruiter" && claims.findLeads === true;
};

function _whenDomReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

/* =========================================================
   FIND LEADS SIDEBAR VISIBILITY
   Runs on every page (auth.js is loaded everywhere) and removes
   the "Find Leads" nav link unless the signed-in user is the
   Beyond Match recruiter account. Fails closed: if we can't
   confirm eligibility for any reason, the link is hidden.
========================================================= */
onAuthStateChanged(auth, async (user) => {
  const hideLeadsLink = () => _whenDomReady(() => {
    document.querySelectorAll('a[href="rec-leads.html"]').forEach(el => el.remove());
  });

  if (!user) { hideLeadsLink(); return; }

  try {
    if (!(await window._isBeyondMatchRecruiter(user))) hideLeadsLink();
  } catch {
    hideLeadsLink();
  }
});


/* =========================================================
   LOGOUT
========================================================= */
// SEC-10: everything the app caches in the tab is derived from the signed-in
// user (job caches, geocode results). Clear it all. localStorage now holds
// only the theme; the old permanent geocode cache is removed here too.
function clearSessionState() {
  try { sessionStorage.clear(); } catch { /* storage unavailable */ }
  clearGeocodeCache();
}

window.unifiedLogout = async function () {
  try {
    await signOut(auth);
    clearSessionState();
    window.location.replace("index.html");
  } catch {
    if (window.showToast) showToast("Logout failed. Please try again.", "error");
    else alert("Logout failed.");
  }
};


/* =========================================================
   AUTH STATE VARIABLES
========================================================= */
let authMode = "login";
let _signupResumeText = ""; // Resume text captured during candidate signup


/* =========================================================
   AUTH MODAL UI CONTROL
========================================================= */
function openAuth(mode) {
  authMode = mode;
  updateAuthUI();
  clearAuthMessage();
  document.getElementById("authOverlay").style.display = "block";
  document.getElementById("authCard").style.display = "block";
}

function closeAuth() {
  document.getElementById("authOverlay").style.display = "none";
  document.getElementById("authCard").style.display = "none";
}

function toggleAuth() {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthUI();
  clearAuthMessage();
}

function updateAuthUI() {
  const title      = document.getElementById("authTitle");
  const text       = document.getElementById("authText");
  const link       = document.getElementById("authToggleLink");
  const btn        = document.querySelector(".auth-btn");
  const roleSelect = document.getElementById("roleSelect");
  const orgInput   = document.getElementById("orgNameInput");
  const resumeWrap = document.getElementById("resumeUploadWrap");
  const pwInput    = document.getElementById("authPassword");
  if (pwInput) pwInput.placeholder = authMode === "signup" ? "Password (12+ characters, upper, lower, number)" : "Password";

  if (authMode === "login") {
    title.innerText = "Login";
    text.innerText  = "Don't have an account?";
    link.innerText  = "Sign Up";
    btn.innerText   = "Login";

    if (roleSelect) roleSelect.style.display = "none";
    if (resumeWrap) resumeWrap.style.display = "none";
  } else {
    title.innerText = "Sign Up";
    text.innerText  = "Already have an account?";
    link.innerText  = "Login";
    btn.innerText   = "Create Account";

    if (roleSelect) roleSelect.style.display = "block";
    if (orgInput)   { orgInput.style.display = "none"; orgInput.value = ""; }
    if (resumeWrap) resumeWrap.style.display = "none";
    _signupResumeText = "";
  }
}


/* =========================================================
   AUTH MESSAGE HELPERS
========================================================= */
function showMessage(text, type = "error") {
  const msg = document.getElementById("authMessage");
  msg.innerText = text;
  msg.className = `auth-message ${type}`;
  msg.style.display = "block";
}

function clearAuthMessage() {
  const msg = document.getElementById("authMessage");
  if (!msg) return;
  msg.innerText = "";
  msg.style.display = "none";
}


/* =========================================================
   PASSWORD POLICY (signup only)
   Existing users keep logging in with whatever password they have;
   the policy applies only when a password is created. Firebase's own
   project policy (validatePassword) is applied on top of the app's
   minimum, so a stricter console setting is reflected here too. The
   authoritative enforcement is the project's server-side password
   policy (Firebase console); this check gives immediate feedback.
========================================================= */
async function _passwordProblem(password) {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return "Password must include an upper-case letter, a lower-case letter and a number.";
  }
  try {
    const status = await validatePassword(auth, password);
    if (!status.isValid) return "Password does not meet the security requirements.";
  } catch { /* policy lookup failed: the rules above and the server still apply */ }
  return "";
}


/* =========================================================
   AUTH FORM — MAIN SUBMIT HANDLER
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  const emailInput    = document.getElementById("authEmail")    || document.querySelector('.auth-card input[type="email"]');
  const passwordInput = document.getElementById("authPassword") || document.querySelector('.auth-card input[type="password"]');
  const btn           = document.querySelector(".auth-btn");

  if (!btn) return;

  // Resume file input handler (candidate signup only)
  const resumeFileInput = document.getElementById("authResumeFile");
  const resumeStatus    = document.getElementById("authResumeStatus");

  if (resumeFileInput) {
    resumeFileInput.addEventListener("change", async () => {
      const file = resumeFileInput.files[0];
      if (!file) return;

      btn.disabled = true;
      resumeStatus.textContent = "Parsing…";
      _signupResumeText = "";

      const ext = file.name.split(".").pop().toLowerCase();
      if (ext !== "pdf" && ext !== "docx") {
        resumeStatus.textContent = "Unsupported file type.";
        btn.disabled = false;
        return;
      }

      try {
        _signupResumeText = await parseResumeFile(file);
        resumeStatus.textContent = "✓ Resume parsed successfully";
      } catch {
        resumeStatus.textContent = "Failed to parse resume.";
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Main submit
  btn.onclick = async () => {
    clearAuthMessage();

    const email    = emailInput.value.trim();
    const password = passwordInput.value;
    const role     = authMode === "signup" ? document.getElementById("roleSelect")?.value : null;

    if (!email || !password)            { showMessage("Please enter email and password."); return; }
    // Self-service signup is limited to the non-privileged roles; admin is
    // granted only via a server-issued custom claim (SEC-01).
    if (authMode === "signup") {
      const problem = await _passwordProblem(password);
      if (problem) { showMessage(problem); return; }
    }
    if (authMode === "signup" && !["candidate", "recruiter"].includes(role)) { showMessage("Please select a role."); return; }

    const orgName = document.getElementById("orgNameInput")?.value.trim();
    if (authMode === "signup" && role === "recruiter" && !orgName) {
      showMessage("Please enter organisation name.");
      return;
    }

    if (authMode === "signup" && role === "candidate") {
      if (!_signupResumeText?.trim()) {
        showMessage("Please upload your resume before signing up.");
        return;
      }
    }

    btn.disabled = true;

    try {
      if (authMode === "signup") {
        await _handleSignup(email, password, role, orgName);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        showMessage("Login successful. Redirecting…", "success");
      }
    } catch (error) {
      // SEC-10: one message for every "bad credentials" outcome, so the login
      // form never reveals whether an account exists.
      const badCredentials = new Set(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"]);
      const messages = {
        "auth/email-already-in-use": "Email already registered. Please login.",
        "auth/invalid-email":        "Invalid email format.",
        "auth/weak-password":        "Password does not meet the security requirements.",
        "auth/too-many-requests":    "Too many attempts. Please wait a few minutes and try again."
      };
      showMessage(
        badCredentials.has(error.code)
          ? "Incorrect email or password."
          : (messages[error.code] || "Authentication failed. Please try again.")
      );
    } finally {
      btn.disabled = false;
    }
  };
});


/* =========================================================
   SIGNUP HANDLER
   Extracted from the submit handler for clarity.
========================================================= */
async function _handleSignup(email, password, role, orgName) {
  const btn = document.querySelector(".auth-btn");

  // Set BEFORE the account exists: creating it fires onAuthStateChanged at once,
  // and the redirect listener must already be told to wait for the signup writes
  // (otherwise a new recruiter is routed to the candidate dashboard).
  _signupInProgress = true;
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, password);
  } catch (e) {
    _signupInProgress = false;
    throw e;
  }
  const uid  = cred.user.uid; // `uid` only exists in THIS function's scope

  // SEC-10: ask the new user to confirm their address. Not enforced (existing
  // accounts are unverified), and a failure here must not block signup.
  let verificationSent = false;
  try { await sendEmailVerification(cred.user); verificationSent = true; } catch { /* non-fatal */ }

  // CRITICAL: as soon as the account is created, Firebase fires
  // onAuthStateChanged — which runs the redirect logic in this same file,
  // on this same page (index.html), IN PARALLEL with the Firestore writes
  // below. Without this flag, the redirect listener can read users/{uid}
  // before role/org/recruiter_id are written, default to "candidate",
  // and navigate away — which aborts this function mid-flight and
  // permanently loses the recruiter data. This flag makes the
  // redirect listener wait for ALL signup writes (any role) to finish
  // before it reads anything.
  _signupInProgress = true;

  const fallbackCandidateId = role === "candidate" ? `local_${uid}` : null;
  const candidateName       = email.split("@")[0];

  try {

  if (role === "candidate") {
    const inferredRole = inferRoleFromResume(_signupResumeText);

    // Write candidate doc immediately so the user can log in without issues
    await setDoc(doc(db, "candidates", fallbackCandidateId), {
      candidate_id: fallbackCandidateId,
      name:         candidateName,
      email,
      user_id:      uid,
      applied_role: inferredRole,
      resume_text:  _signupResumeText,
      is_latest:    true,
      createdAt:    serverTimestamp()
    });

    // Link user → candidate
    await setDoc(doc(db, "users", uid), {
      email,
      role:                "candidate",
      candidate_id:        fallbackCandidateId,
      latest_candidate_id: fallbackCandidateId,
      createdAt:           serverTimestamp()
    });

    // Try to register with the backend and get a real candidate_id
    let backendCandidateId = null;
    if (_signupResumeText.trim()) {
      showMessage("Creating your profile…", "success");
      backendCandidateId = await registerCandidate(
        { name: candidateName, email, resume_text: _signupResumeText },
        5000
      );
    }

    const finalCandidateId = backendCandidateId || fallbackCandidateId;

    // Write or overwrite the candidate doc with the final ID
    _signupInProgress = true;
    try {
      await setDoc(doc(db, "candidates", finalCandidateId), {
        candidate_id: finalCandidateId,
        name:         candidateName,
        email,
        user_id:      uid,
        applied_role: inferRoleFromResume(_signupResumeText),
        resume_text:  _signupResumeText || "",
        is_latest:    true,
        createdAt:    serverTimestamp()
      });
    } catch { }

    // Always write candidate_id to the users doc (role was already set
    // to "candidate" above and is immutable from the client)
    try {
      await setDoc(doc(db, "users", uid), {
        email,
        organisation_name:   null,
        candidate_id:        finalCandidateId,
        latest_candidate_id: finalCandidateId,
        createdAt:           serverTimestamp()
      }, { merge: true });

      // SEC-13: no user id or other identifier goes to the analytics provider.
      logEvent(analytics, "candidate_created", {
        role_detected: inferRoleFromResume(_signupResumeText),
        source:        "signup"
      });
    } catch {
      showMessage("Account created but profile save failed. Please re-login.", "error");
    } finally {
      _signupInProgress = false;
    }

  } else {
    // Recruiter signup. No `role` is written from the browser (SEC-01):
    // the recruiter custom claim is issued server-side, and until then the
    // login redirect's self-heal routes the account via its backend
    // recruiter record.
    await setDoc(doc(db, "users", uid), {
      email,
      organisation_name:   orgName,
      recruiter_id:        uid,
      candidate_id:        null,
      latest_candidate_id: null,
      createdAt:           serverTimestamp()
    }, { merge: true });

    if (role === "recruiter") {
      const payload = {
        recruiter_id: uid, // uid is in scope here — this is correct
        email: email,
        organisation_name: orgName
      };

      try {
        const { ok, status } = await registerRecruiter(payload, { keepalive: true });

        if (!ok) {
          logError("recruiter registration failed", { code: `HTTP ${status}` });
        } else {
          // the backend just granted the recruiter role; pick it up now so the
          // redirect that follows routes this account to the recruiter dashboard
          try { await cred.user.getIdToken(true); } catch { /* non-fatal */ }
        }
      } catch (err) {
        logError("recruiter registration failed", err);
        /* non-fatal — Firestore write already succeeded above, so the
           account still works; the backend record can be retried/backfilled */
      }
    }
  }

  showMessage(
    "Account created successfully 🎉 Please login." +
      (verificationSent ? " We've sent you an email to verify your address." : ""),
    "success"
  );
  authMode = "login";
  updateAuthUI();
  btn.disabled = false;

  } finally {
    // Guaranteed to run whether candidate or recruiter signup —
    // and whether it succeeded or threw. This is what lets the redirect
    // listener stop waiting and safely read the now-complete users/{uid} doc.
    _signupInProgress = false;
  }
}


/* =========================================================
   ROLE SELECT HANDLER
   Toggles org field and resume upload based on the selected
   role during signup.
========================================================= */
document.getElementById("roleSelect")?.addEventListener("change", (e) => {
  const role       = e.target.value;
  const orgInput   = document.getElementById("orgNameInput");
  const resumeWrap = document.getElementById("resumeUploadWrap");

  if (orgInput) {
    orgInput.style.display = role === "recruiter" ? "block" : "none";
    if (role !== "recruiter") orgInput.value = "";
  }

  if (resumeWrap) {
    resumeWrap.style.display = role === "candidate" ? "block" : "none";
    if (role !== "candidate") {
      _signupResumeText = "";
      const fi = document.getElementById("authResumeFile");
      const rs = document.getElementById("authResumeStatus");
      if (fi) fi.value = "";
      if (rs) rs.textContent = "";
    }
  }
});


/* =========================================================
   GLOBAL EXPORTS
   window.auth/window.db are still needed: candidate-dashboard's
   and rec-dash's Power BI boot logic (migrated into candidate.js
   /recruiter.js in a later batch) polls for these globals before
   its own module has finished loading.
========================================================= */
window.auth = auth;
window.db   = db;

window.openAuth   = openAuth;
window.closeAuth  = closeAuth;
window.toggleAuth = toggleAuth;

export { analytics, auth, db };
