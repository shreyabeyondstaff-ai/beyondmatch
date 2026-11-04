/* =========================================================
   SETTINGS.JS
   Account settings page, shared by all three roles. Builds
   the role-appropriate sidebar nav, and handles password
   reset, data export, and account deletion.

   NOTE: the original settings.html loaded api.js via a plain
   <script src="api.js"> (not type="module"). Since api.js has
   top-level export statements, that's a syntax error in a
   classic script — meaning window.showToast/apiFetch never
   actually loaded on this page, and every showToast(...) call
   below threw silently. That's fixed simply by this page now
   importing showToast for real, as a genuine ES module.
========================================================= */

import {
  onAuthStateChanged, sendPasswordResetEmail, deleteUser,
  reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, deleteDoc, updateDoc, collection, query, where, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { auth, db } from "./config.js";
import { showToast, logError, clearGeocodeCache } from "./utils.js";
import { deleteAccountData } from "./api.js";

const $ = id => document.getElementById(id);

/* ── Nav links per role ── */
const NAV = {
  candidate: [
    { href: "candidate-dashboard.html", label: "Dashboard" },
    { href: "resume.html",              label: "Resume Analysis" },
    { href: "jobmatches.html",          label: "Job Matches" },
    { href: "savedjobs.html",           label: "Saved Jobs" },
    { href: "locatehire.html",          label: "LocateHire" },
    { href: "settings.html",            label: "Settings" },
  ],
  recruiter: [
    { href: "rec-dash.html",       label: "Dashboard" },
    { href: "rec-postjob.html",    label: "Post Job" },
    { href: "rec-jobs.html",       label: "My Jobs" },
    { href: "jobs.html",           label: "Jobs" },
    { href: "cand-matches.html",   label: "Candidate Matches" },
    { href: "rec-locatehire.html", label: "CandidateMap" },
    { href: "rec-actions.html",    label: "Recruiter Actions" },
    { href: "settings.html",       label: "Settings" },
  ],
  admin: [
    { href: "admin.html",    label: "Dashboard" },
    { href: "settings.html", label: "Settings" },
  ]
};

// SEC-04: the admin role comes only from the server-issued custom claim.
// The Firestore users/{uid}.role field is a legacy routing hint and can
// never produce "admin" here, so it can't be used to show admin UI.
async function resolveRole(user, data) {
  const { claims } = await user.getIdTokenResult();
  const role = claims.role || data.role || "candidate";
  return role === "admin" && claims.role !== "admin" ? "candidate"
    : ["admin", "recruiter", "candidate"].includes(role) ? role : "candidate";
}

function buildNav(role) {
  const links = NAV[role] || NAV.candidate;
  $("sidebarMenu").innerHTML = links.map(l => `
    <a href="${l.href}" class="menu-item${l.href === 'settings.html' ? ' active' : ''}">${l.label}</a>
  `).join("");
}

onAuthStateChanged(auth, async (user) => {
  // Redirecting logged-out users away from app pages is auth.js's job
  // (its global listener runs on every page); this listener only needs
  // to populate the page once we know who's signed in.
  if (!user) return;

  $("email").textContent = user.email;
  $("uid").textContent   = user.uid;

  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() : {};

  const roleValue = await resolveRole(user, data);
  const roleEl    = $("role");
  roleEl.textContent = roleValue;
  roleEl.className   = `role-badge ${roleValue}`;

  buildNav(roleValue);

  if (data.createdAt?.toDate) {
    const d = data.createdAt.toDate();
    $("since").textContent = d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  } else {
    $("since").textContent = "Recently";
  }
});

const DASH = { admin: "admin.html", recruiter: "rec-dash.html", candidate: "candidate-dashboard.html" };

window.goBack = async () => {
  const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
  const role = await resolveRole(auth.currentUser, snap.exists() ? snap.data() : {});
  location.href = DASH[role] || "candidate-dashboard.html";
};

window.resetPassword = async () => {
  try {
    await sendPasswordResetEmail(auth, auth.currentUser.email);
    showToast("Password reset email sent to " + auth.currentUser.email, "success");
  } catch (e) {
    logError("password reset email failed", e);
    showToast("Could not send the reset email. Please try again later.", "error");
  }
};

// Everything the app stores about the signed-in user, as a JSON file.
// (Applications a recruiter RECEIVES belong to the candidates who sent them
// and are not part of a recruiter's own data.)
window.downloadData = async () => {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};
    const own = (coll, field) =>
      getDocs(query(collection(db, coll), where(field, "==", user.uid)))
        .then(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
    const [candidates, applications, savedJobs, notifications, postedJobs] = await Promise.all([
      own("candidates", "user_id"),
      own("applications", "candidate_user_id"),
      own("saved_jobs", "user_id"),
      own("notifications", "to_user_id"),
      own("posted_jobs", "recruiter_id")
    ]);
    const payload = {
      uid: user.uid, email: user.email, exportedAt: new Date().toISOString(),
      profile: data, candidates, applications, savedJobs, notifications, postedJobs
    };
    const clean = JSON.parse(JSON.stringify(payload, (key, val) =>
      val?.toDate ? val.toDate().toISOString() : val
    ));
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: "beyondmatch_my_data.json" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Your data has been downloaded.", "success");
  } catch (e) {
    logError("data export failed", e);
    showToast("Failed to export your data. Please try again.", "error");
  }
};

// SEC-13: every Firestore document that carries this user's uid and that the
// rules let the owner delete. Nothing here can touch another user's data: the
// queries filter on the signed-in uid, and the rules independently refuse any
// delete of a document that is not the caller's.
const OWNED_DOCS = [
  ["candidates",    "user_id"],            // profile, name, email, resume text
  ["saved_jobs",    "user_id"],
  ["applications",  "candidate_user_id"],  // applications this user sent
  ["notifications", "to_user_id"],         // the user's inbox
  ["notifications", "from_user_id"],       // notifications the user sent to others
  ["posted_jobs",   "recruiter_id"]        // a recruiter's job postings
];

// Returns how many deletions did not succeed.
async function eraseOwnedDocs(uid) {
  let failed = 0;
  for (const [coll, field] of OWNED_DOCS) {
    try {
      const snap = await getDocs(query(collection(db, coll), where(field, "==", uid)));
      const results = await Promise.allSettled(snap.docs.map(d => deleteDoc(d.ref)));
      failed += results.filter(r => r.status === "rejected").length;
    } catch (e) {
      logError(`erase ${coll} failed`, e);
      failed += 1;
    }
  }
  return failed;
}

// A recruiter's private notes on candidates are the recruiter's own data, but
// they live inside the candidate's application, which stays with the candidate
// (or the candidate's own deletion). Blank them. Best effort: needs the
// recruiter role claim, so a failure does not block deleting the account.
async function scrubRecruiterNotes(uid) {
  try {
    const snap = await getDocs(query(collection(db, "applications"), where("recruiter_id", "==", uid)));
    await Promise.allSettled(snap.docs
      .filter(d => d.data().rec_note)
      .map(d => updateDoc(d.ref, { rec_note: "", note_updated_at: serverTimestamp() })));
  } catch (e) {
    logError("recruiter note scrub failed", e);
  }
}

window.deleteAccount = async () => {
  const user = auth.currentUser;
  if (!user) return;
  const confirmed = confirm("Delete your account? This will permanently delete your account, profile, resumes, applications, saved jobs and notifications. This cannot be undone.");
  if (!confirmed) return;
  const password = prompt("Please enter your password to confirm:");
  if (!password) return;
  try {
    const credential = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, credential);

    // 1. Records held by the backend (needs the signed-in session, so it goes first).
    const backend = await deleteAccountData();
    if (backend === "failed") {
      showToast("We could not delete your data on our servers, so your account was NOT deleted. Please try again.", "error");
      return;
    }

    // 2. Everything in Firestore. Stop before deleting the login if any of it
    //    remains: once the login is gone there is no way to retry.
    await scrubRecruiterNotes(user.uid);
    const failed = await eraseOwnedDocs(user.uid);
    let profileFailed = false;
    if (!failed) {
      // The users document goes last: it is what lets a retry find the account.
      try { await deleteDoc(doc(db, "users", user.uid)); } catch (e) { logError("erase users failed", e); profileFailed = true; }
    }
    if (failed || profileFailed) {
      showToast("We could not delete all of your data, so your account was NOT deleted. Please try again.", "error");
      return;
    }

    // 3. Data this browser keeps, then the login itself.
    try { sessionStorage.clear(); } catch { /* storage unavailable */ }
    clearGeocodeCache();
    await deleteUser(user);

    showToast(
      backend === "done"
        ? "Your account and data have been deleted."
        : "Your account and the data stored in this app have been deleted. Some records on our servers are removed separately and may take longer.",
      "success"
    );
    await new Promise(r => setTimeout(r, 1500));
    window.location.href = "index.html";
  } catch (e) {
    if (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential") {
      showToast("Incorrect password. Account not deleted.", "error");
    } else {
      logError("account deletion failed", e);
      showToast("Failed to delete your account. Please try again.", "error");
    }
  }
};

// unifiedLogout() is provided globally by auth.js — no local copy needed.
