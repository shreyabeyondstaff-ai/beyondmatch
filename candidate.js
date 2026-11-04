/* =========================================================
   CANDIDATE.JS
   Covers every candidate-facing page:
     candidate-dashboard.html · jobmatches.html · locatehire.html
     savedjobs.html · resume.html · cand_actions.html
   Each section below only runs if that page's DOM elements are
   present, so one module can safely load on every candidate page.
========================================================= */

import {
  collection, getDocs, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  doc, query, where, orderBy, limit, writeBatch, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { auth, db } from "./config.js";
import { resolveToBackendId } from "./auth.js";
import { getJobs, getMatches, registerCandidate, trackInteraction, getEmbedToken, isSafeId } from "./api.js";
import { callGemini } from "./gemini.js";
import { embedPowerBI } from "./powerbi.js";
import {
  showToast, showJobsSkeletonLoader, showErrorBanner, setProgress, logError,
  formatSalary, escHtml, escAttr, safeUrl, safeMailto, timeSince, statusColor, statusIcon,
  parseResumeFile, inferRoleFromResume,
  createEntityMap, resolveCountryLabel
} from "./utils.js";

const $ = id => document.getElementById(id);


/* =========================================================
   SHARED HELPERS (used by more than one candidate page)
========================================================= */

// Single source of truth for "is this job internal (BeyondMatch-posted)
// or external (job-board API)?" — used both when rendering match cards
// and when handling an Apply click.
function isInternalJobCard(data) {
  const source  = (data.source || "").toLowerCase();
  const jobType = (data.job_type || "").toLowerCase();
  const applyUrl = data.apply_url || "";
  return (
    source === "beyondmatch" ||
    jobType === "internal" ||
    (!source && !!data.recruiter_id) ||
    applyUrl.includes("cand_actions.html")
  );
}

function openApplyLink(url) {
  // SEC-03: http(s) only — blocks javascript:/data: URLs from API/Firestore data
  const safe = (!url || url === "#") ? "" : safeUrl(url);
  if (!safe) {
    showToast("No application link available for this job.", "warning");
    return;
  }
  window.open(safe, "_blank", "noopener,noreferrer");
}
window.openApplyLink = openApplyLink;

// resolveToBackendId now lives in auth.js (imported above) — it's an
// identity concern (migrating a placeholder "local_<uid>" candidate ID
// to a real backend ID), not jobmatches-specific, so auth.js is the
// single source of truth for it.


/* =========================================================
   APPLY TO JOB  (previously apply-job.js)
   Creates the application + recruiter notification in
   Firestore. Shared by jobmatches.html and cand_actions.html.
========================================================= */
let _isSubmittingApplication = false;

function waitForAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
  });
}

async function applyToJob(jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName) {
  if (_isSubmittingApplication) return false;
  _isSubmittingApplication = true;
  try {
    return await _doApply(jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName);
  } finally {
    _isSubmittingApplication = false;
  }
}

async function _doApply(jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName) {
  if (!jobId) {
    showToast("Could not identify the job. Please refresh and try again.", "error");
    return false;
  }

  const user = await waitForAuth();
  if (!user) {
    showToast("Please log in to apply.", "warning");
    return false;
  }

  const userSnap = await getDoc(doc(db, "users", user.uid)).catch(() => null);
  if (!userSnap?.exists()) {
    showToast("Candidate profile not found.", "error");
    return false;
  }
  const userData = userSnap.data();
  const candidateId = userData.candidate_id || userData.latest_candidate_id;
  if (!candidateId) {
    showToast("Please complete your profile first.", "warning");
    return false;
  }

  let candidateName  = user.email?.split("@")[0] || "Candidate";
  let candidateEmail = user.email || "";
  let candidateRole  = "";
  try {
    const cSnap = await getDoc(doc(db, "candidates", candidateId));
    if (cSnap.exists()) {
      const cd = cSnap.data();
      candidateName  = cd.name  || candidateName;
      candidateEmail = cd.email || candidateEmail;
      candidateRole  = cd.applied_role || "";
    }
  } catch { /* use fallbacks */ }

  // Company name: prefer what the card passed in; only fall back to a
  // Firestore lookup if this looks like a real posted-job doc id.
  let resolvedCompany = companyName || "";
  if (!resolvedCompany && jobFirestoreId && jobFirestoreId !== jobId) {
    try {
      const jobSnap = await getDoc(doc(db, "posted_jobs", jobFirestoreId));
      if (jobSnap.exists()) {
        const jd = jobSnap.data();
        resolvedCompany = jd.organisation_name || jd.company || jd.company_name || "";
      }
    } catch { /* non-critical */ }
  }

  // Duplicate-application check — must not silently swallow errors here,
  // or we risk creating a duplicate application.
  try {
    const dupQ = query(
      collection(db, "applications"),
      where("candidate_user_id", "==", user.uid),
      where("job_id", "==", jobId)
    );
    const dupSnap = await getDocs(dupQ);
    if (!dupSnap.empty) {
      showToast("You've already applied to this job.", "info", "Already Applied");
      return false;
    }
  } catch {
    showToast("Could not verify application status. Please try again.", "error");
    return false;
  }

  let appRef;
  try {
    appRef = await addDoc(collection(db, "applications"), {
      job_id:            jobId,
      job_firestore_id:  jobFirestoreId || jobId,
      job_title:         jobTitle,
      company_name:      resolvedCompany,
      candidate_id:      candidateId,
      candidate_user_id: user.uid,
      candidate_name:    candidateName,
      candidate_email:   candidateEmail,
      candidate_role:    candidateRole,
      recruiter_id:      recruiterId,
      status:            "applied",
      note:              candidateNote || "",
      rec_unread:        true,
      cand_unread:       false,
      status_history:    [],
      applied_at:        serverTimestamp(),
      updated_at:        serverTimestamp()
    });
  } catch {
    showToast("Application failed. Please try again.", "error");
    return false;
  }

  if (recruiterId) {
    try {
      await addDoc(collection(db, "notifications"), {
        to_user_id:     recruiterId,
        to_role:        "recruiter",
        from_role:      "candidate",
        from_user_id:   user.uid, // SEC-11: firestore.rules requires this to equal the signed-in uid
        type:           "new_application",
        app_id:         appRef.id,
        job_id:         jobId,
        job_title:      jobTitle,
        candidate_name: candidateName,
        message:        `${candidateName} applied for "${jobTitle}".`,
        read:           false,
        created_at:     serverTimestamp()
      });
    } catch { /* non-critical */ }
  }

  showToast(`Applied to ${jobTitle}!`, "success", "Application Sent");
  return true;
}

async function hasApplied(jobId) {
  const user = await waitForAuth();
  if (!user) return false;
  try {
    const q = query(
      collection(db, "applications"),
      where("candidate_user_id", "==", user.uid),
      where("job_id", "==", jobId)
    );
    const snap = await getDocs(q);
    return !snap.empty;
  } catch { return false; }
}

// Call after rendering job cards to grey out Apply buttons for jobs
// the candidate has already applied to.
async function markApplyButtons(jobs) {
  const user = await waitForAuth();
  if (!user || !jobs?.length) return;

  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    const candidateId = userSnap.exists()
      ? (userSnap.data().candidate_id || userSnap.data().latest_candidate_id)
      : null;
    if (!candidateId) return;

    // SEC-11: filter on candidate_user_id (the signed-in uid): that is the field
    // the Firestore rules use to prove ownership of an application.
    const q = query(collection(db, "applications"), where("candidate_user_id", "==", user.uid));
    const snap = await getDocs(q);
    const applied = new Set(snap.docs.map(d => d.data().job_id));

    document.querySelectorAll("[data-apply-job]").forEach(btn => {
      const jobId = btn.getAttribute("data-apply-job");
      if (applied.has(jobId)) {
        btn.textContent   = "✓ Applied";
        btn.disabled      = true;
        btn.style.opacity = "0.6";
        btn.style.cursor  = "default";
      }
    });
  } catch { /* best-effort */ }
}

window.applyToJob      = applyToJob;
window.hasApplied      = hasApplied;
window.markApplyButtons = markApplyButtons;


/* =========================================================
   QUICK-APPLY MODAL
   Shared by jobmatches.html and cand_actions.html — both pages
   have the same modal markup (applyOverlay/applyModalTitle/
   applyModalSub/applyStatusMsg/applyNoteInput/applySubmitBtn).
========================================================= */
function openApplyModal(jobId, jobTitle, recruiterId, firestoreId, company) {
  window._pendingApply = {
    jobId, jobTitle, recruiterId,
    firestoreId: firestoreId || jobId,
    company: company || ""
  };
  $("applyModalTitle").textContent = jobTitle || "Apply";
  $("applyModalSub").textContent   = "You're one step away — submit your application to be considered for this role.";
  $("applyStatusMsg").style.display = "none";
  $("applyNoteInput").value = "";
  const btn = $("applySubmitBtn");
  btn.disabled = false;
  btn.textContent = "🚀 Submit Application";
  $("applyOverlay").style.display = "flex";
}

function closeApplyModal() {
  $("applyOverlay").style.display = "none";
  $("applyNoteInput").value = "";
  $("applyStatusMsg").style.display = "none";
  delete window._pendingApply;
}

async function submitApplyModal() {
  if (window._modalSubmitting) return;
  window._modalSubmitting = true;

  const pending = window._pendingApply;
  if (!pending) { window._modalSubmitting = false; return; }

  const note  = $("applyNoteInput").value.trim();
  const btn   = $("applySubmitBtn");
  const msgEl = $("applyStatusMsg");

  btn.disabled = true;
  btn.textContent = "⏳ Submitting…";
  msgEl.style.display = "none";

  const setMsg = (text, tone) => {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    const TONES = {
      blue: { text: light ? "#3a5fd9" : "#7aa2ff", bg: light ? "rgba(58,95,217,.08)" : "rgba(122,162,255,.05)", border: light ? "rgba(58,95,217,.3)" : "rgba(122,162,255,.2)" },
      green: { text: light ? "#157a3d" : "#4ade80", bg: light ? "rgba(21,128,61,.08)" : "rgba(74,222,128,.05)", border: light ? "rgba(21,128,61,.3)" : "rgba(74,222,128,.2)" },
      red: { text: light ? "#dc2626" : "#f87171", bg: light ? "rgba(220,38,38,.08)" : "rgba(248,113,113,.05)", border: light ? "rgba(220,38,38,.3)" : "rgba(248,113,113,.2)" }
    };
    const c = TONES[tone] || TONES.blue;
    msgEl.textContent = text;
    msgEl.style.cssText = `background:${c.bg};border:1px solid ${c.border};color:${c.text};display:block;font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:14px;`;
  };

  try {
    const already = await hasApplied(pending.jobId);
    if (already) {
      setMsg(`✋ You've already applied to "${pending.jobTitle}".`, "blue");
      btn.disabled = false;
      btn.textContent = "🚀 Submit Application";
      return;
    }

    const ok = await applyToJob(pending.jobId, pending.jobTitle, pending.recruiterId, pending.firestoreId, note, pending.company);

    if (ok) {
      setMsg("✅ Application submitted! Track it in Candidate Actions.", "green");
      btn.textContent = "✓ Applied";
      document.querySelectorAll(`[data-apply-job="${CSS.escape(String(pending.jobId))}"]`).forEach(b => {
        b.textContent = "✓ Applied";
        b.disabled = true;
        b.style.opacity = "0.6";
        b.style.cursor = "default";
      });
      setTimeout(() => closeApplyModal(), 2000);
    } else {
      setMsg("You've already applied to this job, or something went wrong. Please try again.", "red");
      btn.disabled = false;
      btn.textContent = "🚀 Submit Application";
    }
  } finally {
    window._modalSubmitting = false;
  }
}

window.openApplyModal   = openApplyModal;
window.closeApplyModal  = closeApplyModal;
window.submitApplyModal = submitApplyModal;

// Reads ?apply=<jobId> from the URL (sent by a recruiter's "invite to apply"
// notification link) and opens the Quick Apply modal pre-filled.
//
// SEC-14: ONLY the job id is taken from the URL, and it is validated. The
// job's title, company and recruiter come from the platform's own job record,
// never from the link. A crafted link such as ?apply=X&recruiter=<someone>
// therefore cannot make a candidate apply to a recruiter of the attacker's
// choosing. Any other parameter (title, recruiter, firestore_id, company) is
// ignored, so links in existing notifications keep working.
async function resolveInviteJob(jobId) {
  const user = await waitForAuth();
  if (!user) return null;

  // 1. The Firestore copy of a job a recruiter posted on this platform.
  try {
    const snap = await getDocs(query(collection(db, "posted_jobs"), where("job_id", "==", jobId), limit(1)));
    if (!snap.empty) {
      const d = snap.docs[0].data();
      return {
        title: d.title || "this job",
        recruiterId: typeof d.recruiter_id === "string" ? d.recruiter_id : "",
        company: d.company || d.organisation_name || "",
        firestoreId: snap.docs[0].id
      };
    }
  } catch { /* fall back to the job list */ }

  // 2. The backend's job list.
  try {
    const job = (await getJobs()).find(j => String(j.job_id) === jobId);
    if (job) {
      return {
        title: job.title || "this job",
        recruiterId: typeof job.recruiter_id === "string" ? job.recruiter_id : "",
        company: job.company || "",
        firestoreId: job.id || job.firestore_id || jobId
      };
    }
  } catch { /* not found */ }

  return null;
}

function checkApplyUrlParam() {
  const params   = new URLSearchParams(window.location.search);
  const applyJob = params.get("apply");
  if (!applyJob) return;

  // Read once, then remove every parameter from the address bar.
  window.history.replaceState({}, "", window.location.pathname);

  if (!isSafeId(applyJob)) {
    showToast("That invitation link is not valid.", "warning");
    return;
  }

  function tryOpen(job) {
    const overlay = $("applyOverlay");
    if (!overlay) { setTimeout(() => tryOpen(job), 80); return; }
    openApplyModal(applyJob, job.title, job.recruiterId, job.firestoreId, job.company);
  }

  resolveInviteJob(applyJob).then(job => {
    if (!job) { showToast("This job is no longer available.", "warning"); return; }
    tryOpen(job);
  });
}


/* =========================================================
   ============  CANDIDATE-DASHBOARD.HTML  ================
   Power BI overview + profile pill.
========================================================= */
if ($("pbi-container")) {
  window.boot = async function boot() {
    try {
      if (!window.auth || !window.db || !window.auth.currentUser) {
        console.warn("Auth not ready"); return;
      }

      const user  = window.auth.currentUser;
      const email = user.email;

      const uSnap = await getDoc(doc(window.db, "users", user.uid));
      if (!uSnap.exists()) { showErrorBanner("User data not found"); return; }

      const ud  = uSnap.data();
      const cid = ud.latest_candidate_id || ud.candidate_id || "—";
      let name = email.split("@")[0];
      let role = "General";

      try {
        const cSnap = await getDoc(doc(window.db, "candidates", cid));
        if (cSnap.exists()) {
          name = cSnap.data().name         || name;
          role = cSnap.data().applied_role || role;
        }
      } catch { /* use defaults */ }

      const ini = name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
      $("av").textContent    = ini;
      $("pname").textContent = name;
      $("prole").textContent = role;
      $("pid").textContent   = `ID: ${cid}`;
      $("pill").style.display = "flex";
      $("sub").textContent   = "Analytics powered by Power BI";

      const token = await getEmbedToken();

      if (!token.ok) {
        logError("embed token request failed", { code: `HTTP ${token.status}` });
        showErrorBanner("The analytics dashboard is unavailable right now. Please try again later.");
        return;
      }
      if (!token.accessToken || !token.embedUrl) {
        logError("embed token response incomplete", { code: "missing-fields" });
        showErrorBanner("The analytics dashboard is unavailable right now. Please try again later.");
        return;
      }

      embedPowerBI({
        accessToken: token.accessToken,
        embedUrl:    token.embedUrl,
        reportId:    token.reportId,
        tokenType:   token.tokenType
      });

    } catch (err) {
      logError("candidate dashboard failed", err);
      showErrorBanner("Could not load this page. Please refresh and try again.");
    }
  };

  (function initDashboard() {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (window.auth && window.db) {
        clearInterval(t);
        if (typeof window.auth.onAuthStateChanged === "function") {
          window.auth.onAuthStateChanged(user => { if (user) window.boot(); });
        } else {
          window.boot();
        }
      }
      if (tries > 50) { clearInterval(t); console.warn("Auth timeout"); }
    }, 100);
  })();
}


/* =========================================================
   ================  JOBMATCHES.HTML  ======================
   Resume selection, AI-ranked job matches, filters, apply,
   save, and the "Know More" job-breakdown modal.
========================================================= */
if ($("matchesGrid")) {
  // Idle placeholder shown before a resume is selected
  $("matchesGrid").innerHTML = `
    <div class="empty-state" id="idleState">
      <div class="empty-state-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>
      <h4>Select a resume to find matches</h4>
      <p>Choose your resume above and click <strong style="color:var(--blue, #7aa2ff);">View Matches</strong> to see AI-matched jobs.</p>
    </div>`;

  // ── LLM enrichment cache ──
  // SEC-17: kept in memory only. The insights are derived from the candidate's
  // resume, so they are not written to browser storage; a reload recomputes them.
  const _llmCache = new Map();
  const llmMatchCache = {
    get(k) { return k ? (_llmCache.get(k) ?? null) : null; },
    set(k, v) { if (k) _llmCache.set(k, v); }
  };

  async function enrichMatchesWithLLM(matches, allJobs, cacheKey) {
    if (cacheKey) {
      const cached = llmMatchCache.get(cacheKey);
      if (cached && cached.some(r => r.ai_insight !== null)) return cached;
    }

    const top10 = matches.slice(0, 10);
    const slim = top10.map((m, i) => {
      const job = allJobs.find(j => j.job_id === m.job_id) || {};
      return {
        index: i,
        job_id: m.job_id,
        title: m.title || job.title || "Unknown",
        jd_snippet: (job.description || m.description || m.jd || "").slice(0, 200),
        match_percent: m.match_percent
      };
    });

    const prompt = `You are a career advisor helping a candidate understand their job matches.
For each job write ONE short sentence (max 14 words) telling the candidate something specific about why this role could suit them.
Rules:
- Read jd_snippet carefully — mention what the role actually involves
- If jd_snippet is empty, infer from the job title
- NEVER use: "high match", "great fit", "strong match", "relevant experience", "aligns with your background"
- Each sentence must be unique and specific to that job
- NEVER return null for ai_insight — always write something based on the title if nothing else
- Re-rank by match_percent descending (higher % = ai_rank 1)
Return ONLY a raw JSON array, no markdown:
[{"index":<n>,"job_id":"...","ai_rank":<n>,"ai_insight":"<one specific sentence about this role>"}]

Jobs:
${JSON.stringify(slim)}`;

    const fallback = () => matches.map((m, i) => {
      const job = allJobs.find(j => j.job_id === m.job_id) || {};
      const title = m.title || job.title || "this role";
      return { job_id: m.job_id, ai_rank: i + 1, ai_insight: `Focuses on ${title.toLowerCase()} responsibilities and related skills.` };
    });

    try {
      const raw = await Promise.race([
        callGemini(prompt, "recommendations"),
        new Promise(resolve => setTimeout(() => resolve(""), 12000))
      ]);
      if (!raw) return fallback();

      const clean = raw.replace(/```json|```/g, "").trim();
      const jsonStr = clean.match(/\[[\s\S]*\]/)?.[0] || clean;
      const parsed = JSON.parse(jsonStr);

      const byJobId = {}, byIndex = {};
      parsed.forEach(r => {
        if (r.job_id) byJobId[r.job_id] = r;
        if (r.index != null) byIndex[r.index] = r;
      });

      const result = matches.map((m, i) => {
        const r = byJobId[m.job_id] || byIndex[i] || {};
        return { job_id: m.job_id, ai_rank: r.ai_rank ?? (i + 1), ai_insight: r.ai_insight || null };
      });

      if (cacheKey) llmMatchCache.set(cacheKey, result);
      return result;
    } catch {
      return fallback();
    }
  }

  async function loadUserCandidatesOnly() {
    const select = $("candidateSelect");
    if (!select) return;
    const user = auth.currentUser;
    if (!user) return;

    select.innerHTML = `<option value="">Select your resume</option>`;

    const [snapshot, userSnap] = await Promise.all([
      getDocs(query(collection(db, "candidates"), where("user_id", "==", user.uid))),
      getDoc(doc(db, "users", user.uid)).catch(() => null)
    ]);

    const latestId = userSnap?.exists?.() ? (userSnap.data().latest_candidate_id || null) : null;

    const seenIds = new Set();
    const userDocs = [];
    snapshot.forEach(docSnap => {
      if (seenIds.has(docSnap.id)) return;
      seenIds.add(docSnap.id);
      userDocs.push({ id: docSnap.id, ...docSnap.data() });
    });
    userDocs.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));

    const latestDocId = latestId || (userDocs[0]?.id ?? null);
    const ordered = [
      ...userDocs.filter(d => d.id === latestDocId),
      ...userDocs.filter(d => d.id !== latestDocId)
    ];

    ordered.forEach(data => {
      const isLatest = data.id === latestDocId;
      const role = data.applied_role || "General";
      const dateStr = data.createdAt?.toDate
        ? data.createdAt.toDate().toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
        : "";

      const option = document.createElement("option");
      option.value = data.id;
      option.textContent = isLatest
        ? `★ ${data.name} – ${role}${dateStr ? ` (${dateStr})` : ""} [Latest]`
        : `${data.name} – ${role}${dateStr ? ` (${dateStr})` : ""}`;
      if (isLatest) option.selected = true;
      select.appendChild(option);
    });
  }

  function setupMatchFilters() {
    const locationFilter = $("locationFilter");
    const matchFilter    = $("matchFilter");
    const salarySort     = $("salarySort");
    if (!locationFilter) return;

    const cards = () => document.querySelectorAll(".match-card");

    const locations = new Set();
    cards().forEach(c => locations.add(c.dataset.location));
    locationFilter.innerHTML =
      `<option value="">All Locations</option>` +
      [...locations].map(l => `<option value="${escAttr(l)}">${escHtml(l)}</option>`).join("");

    function applyFilters() {
      const loc = locationFilter.value;
      const minMatch = matchFilter.value;

      cards().forEach(card => {
        const visible =
          (!loc || card.dataset.location === loc) &&
          (!minMatch || Number(card.dataset.match) >= Number(minMatch));
        card.style.display = visible ? "block" : "none";
      });

      if (salarySort.value) {
        const grid = $("matchesGrid");
        const sorted = [...cards()].sort((a, b) => {
          const diff = Number(a.dataset.salary) - Number(b.dataset.salary);
          return salarySort.value === "high" ? -diff : diff;
        });
        sorted.forEach(card => grid.appendChild(card));
      }
    }

    locationFilter.onchange = applyFilters;
    matchFilter.onchange    = applyFilters;
    salarySort.onchange     = applyFilters;
  }

  async function saveJobToFirebase(job, candidateId) {
    const user = auth.currentUser;
    if (!user) return;
    if (!job?.job_id) {
      showToast("Job data is missing. Please try again.", "error");
      return;
    }

    const docId = `${user.uid}_${candidateId}_${job.job_id}`;
    await setDoc(doc(db, "saved_jobs", docId), {
      user_id:      user.uid,
      candidate_id: candidateId,
      job_id:       job.job_id,
      title:        job.title || "Untitled Job",
      company:      job.company || "Company not available",
      location:     job.location_display || job.location ||
        (job.city && job.country ? `${job.city}, ${job.country}` : "Location not specified"),
      salary_min:   job.salary_min ?? null,
      salary_max:   job.salary_max ?? null,
      description:  job.description || "",
      apply_url:    job.apply_url || "#",
      savedAt:      serverTimestamp()
    });

    trackInteraction({ job_id: job.job_id, candidate_id: candidateId, action: "shortlist" });
    showToast("Job saved to your list.", "success");
  }

  async function handleSaveJob(btn, job, candidateId) {
    if (btn.dataset.saved) return;
    try {
      await saveJobToFirebase(job, candidateId);
      btn.dataset.saved = "1";
      btn.classList.add("saved");
      btn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Saved`;
    } catch { /* leave button in its previous state */ }
  }
  window.handleSaveJob = handleSaveJob;

  async function loadCandidateJobMatches() {
    const select = $("candidateSelect");
    const candidateId = select?.value;
    const grid = $("matchesGrid");

    if (!candidateId) {
      showToast("Please select a resume first.", "warning");
      return;
    }

    showJobsSkeletonLoader(grid, 8);

    const resolvedId = await resolveToBackendId(candidateId);
    if (resolvedId !== candidateId) {
      const opt = select.querySelector(`option[value="${CSS.escape(String(candidateId))}"]`);
      if (opt) opt.value = resolvedId;
      select.value = resolvedId;
    }

    if (resolvedId.startsWith("local_")) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <h4>Resume not yet uploaded</h4>
          <p>Go to <a href="resume.html" style="color:var(--blue, #7aa2ff);">Resume Analysis</a> and upload your resume first to enable job matching.</p>
        </div>`;
      return;
    }

    const [{ matches }, allJobs] = await Promise.all([
      getMatches({ candidate_id: resolvedId, top_n: 50, offset: 0 }),
      getJobs()
    ]);

    if (!matches.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <h4>No matches found</h4>
          <p>We couldn't find any suitable jobs for this candidate right now.</p>
        </div>`;
      return;
    }

    const llmResults = await enrichMatchesWithLLM(matches, allJobs, candidateId);
    const llmMap = {};
    llmResults.forEach(r => { llmMap[r.job_id] = r; });

    const ranked = [...matches].sort((a, b) => {
      const ra = llmMap[a.job_id]?.ai_rank ?? 999;
      const rb = llmMap[b.job_id]?.ai_rank ?? 999;
      return ra - rb;
    });

    const cardFragments = [];
    window.__jobCardData = window.__jobCardData || {};

    ranked.forEach((match, idx) => {
      const job = allJobs.find(j => j.job_id === match.job_id) || match || {};
      const location = job.location_display || job.location ||
        (job.city && job.country ? `${job.city}, ${job.country}` : job.city || job.country || "Not specified");
      const company = job.company || match.company || "Company not available";
      const salary = formatSalary(job);
      const percent = match.match_percent != null ? match.match_percent.toFixed(1) : "0.0";
      const aiInsight = llmMap[match.job_id]?.ai_insight;
      const isTopPick = idx === 0;

      const cardData = {
        job_id:       job.job_id || match.job_id,
        firestore_id: job.id || job.firestore_id || job.job_id || match.job_id,
        title:        match.title || job.title || "Job Title",
        company, location, salary, percent,
        description:  job.description || "",
        apply_url:    job.apply_url || match.apply_url || "",
        source:       (job.source || match.source || "").toLowerCase(),
        job_type:     (job.job_type || match.job_type || "").toLowerCase(),
        recruiter_id: job.recruiter_id || match.recruiter_id || ""
      };
      window.__jobCardData[cardData.job_id] = { ...cardData, candidateId };

      const pct = parseFloat(percent);
      const circ = 113;
      const offset = circ - (pct / 100) * circ;
      const ringColor = pct >= 80 ? "var(--green, #4ade80)" : pct >= 60 ? "var(--blue, #7aa2ff)" : pct >= 40 ? "var(--amber, #fbbf24)" : "var(--red, #f87171)";

      cardFragments.push(`
        <div class="match-card ${isTopPick ? "top-pick" : ""}"
             style="animation-delay:${idx * 60}ms"
             data-location="${escAttr(location)}"
             data-match="${escAttr(percent)}"
             data-salary="${escAttr(job.salary_min || 0)}"
             data-jobid="${escAttr(cardData.job_id)}">

          ${isTopPick ? `<span class="top-pick-badge">★ AI Top Pick</span>` : ""}

          <div class="match-card-header">
            <div class="match-card-titles">
              <div class="match-card-title">${escHtml(cardData.title)}</div>
              <div class="match-card-company">${escHtml(company)}</div>
            </div>
            <div class="match-pct">
              <div class="match-ring">
                <svg viewBox="0 0 40 40">
                  <circle class="ring-bg" cx="20" cy="20" r="18"/>
                  <circle class="ring-fill" cx="20" cy="20" r="18" stroke="${ringColor}"
                    stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
                    fill="none" stroke-width="3.5" stroke-linecap="round"
                    style="transform:rotate(-90deg);transform-origin:center"/>
                </svg>
                <div class="match-ring-label">${Math.round(pct)}%</div>
              </div>
            </div>
          </div>

          <div class="match-meta">
            <span class="meta-chip">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
              </svg>
              ${escHtml(location)}
            </span>
          </div>

          <div class="match-salary">${escHtml(salary)}</div>

          ${aiInsight ? `<div class="match-insight">✦ ${escHtml(aiInsight)}</div>` : ""}

          <div class="match-actions">
            ${isInternalJobCard(cardData)
              ? `<button class="match-btn apply"
    data-apply-job="${escAttr(cardData.job_id)}"
    data-job-title="${escAttr(cardData.title)}"
    data-recruiter-id="${escAttr(cardData.recruiter_id || '')}"
    data-firestore-id="${escAttr(cardData.firestore_id || cardData.job_id)}"
    data-candidate-id="${escAttr(candidateId)}"
    data-source="${escAttr(cardData.source || '')}"
    data-job-type="${escAttr(cardData.job_type || '')}"
    data-company="${escAttr(cardData.company || '')}"
    data-apply-url="${escAttr(cardData.apply_url || '#')}"
    onclick="window._applyClick(this)">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
    Apply
  </button>`
              : `<button class="match-btn apply"
                   data-apply-url="${escAttr(cardData.apply_url || '#')}"
                   onclick="openApplyLink(this.dataset.applyUrl)">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  Apply
                </button>`
            }
            <button class="match-btn save"
                    data-savejobid="${escAttr(cardData.job_id)}"
                    data-candidate-id="${escAttr(candidateId)}"
                    onclick="handleSaveJob(this, window.__jobCardData[this.dataset.savejobid], this.dataset.candidateId)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
              </svg>
              Save
            </button>
            <button class="match-btn know know-more-btn" data-jobid="${escAttr(cardData.job_id)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Know More
            </button>
          </div>
        </div>
      `);
    });

    grid.innerHTML = cardFragments.join("");
    setupMatchFilters();
    setupKnowMoreButtons(candidateId);
    markApplyButtons(ranked.map(m => ({
      job_id: m.job_id,
      recruiter_id: (allJobs.find(j => j.job_id === m.job_id) || m).recruiter_id || ""
    })));
  }
  window.loadCandidateJobMatches = loadCandidateJobMatches;

  window._applyClick = async function (btn) {
    const jobId =
      btn.dataset.applyJob ||
      btn.getAttribute("data-apply-job") ||
      btn.closest(".match-card")?.dataset.jobid;

    const jobTitle =
      btn.dataset.jobTitle ||
      btn.closest(".match-card")?.querySelector(".match-card-title")?.textContent?.trim() ||
      "Job";

    const recruiterId =
      btn.dataset.recruiterId ||
      btn.closest(".match-card")?.dataset.recruiterId ||
      "";

    const firestoreId = btn.dataset.firestoreId;
    const cardData  = window.__jobCardData?.[jobId] || {};
    const source    = (btn.dataset.source  || cardData.source   || "").toLowerCase();
    const jobType   = (btn.dataset.jobType || cardData.job_type || "").toLowerCase();
    const applyUrl  = btn.dataset.applyUrl || cardData.apply_url || "";
    const company   = btn.dataset.company  || cardData.company  || "";

    if (!jobId) {
      showToast("Could not identify the job. Please refresh and try again.", "error");
      return;
    }

    const isInternal = isInternalJobCard({ source, job_type: jobType, recruiter_id: recruiterId, apply_url: applyUrl });

    if (!isInternal) {
      openApplyLink(applyUrl);
      return;
    }

    // Internal BeyondMatch job — open the inline apply modal.
    openApplyModal(jobId, jobTitle, recruiterId, firestoreId, company);
  };

  // Auth listener — loads the user's resumes once authenticated
  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    if ($("candidateSelect")) loadUserCandidatesOnly();
  });

  checkApplyUrlParam();

  // Intercepts apply-button clicks on dynamically-added match cards
  // (belt-and-suspenders alongside the onclick attribute already on
  // each generated button).
  (function patchApplyButtons() {
    const grid = $("matchesGrid");
    if (!grid) return;

    function patchCard(card) {
      const applyBtn = card.querySelector(".match-btn.apply");
      if (!applyBtn) return;
      applyBtn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        window._applyClick(applyBtn);
      };
    }

    const observer = new MutationObserver(mutations => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          if (node.classList?.contains("match-card")) patchCard(node);
          node.querySelectorAll?.(".match-card").forEach(patchCard);
        });
      });
    });
    observer.observe(grid, { childList: true, subtree: true });
  })();

  /* ── Know More modal ── */
  const knowMoreCache = {};

  function setupKnowMoreButtons(candidateId) {
    document.querySelectorAll(".know-more-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const jobId = btn.getAttribute("data-jobid");
        const jobData = window.__jobCardData?.[jobId];
        if (!jobData) return;
        openKnowMoreModal(jobData, candidateId);
      });
    });
  }

  async function openKnowMoreModal(jobData, candidateId) {
    if (!$("knowMoreOverlay")) {
      const overlay = document.createElement("div");
      overlay.id = "knowMoreOverlay";
      overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.75);
        backdrop-filter:blur(6px); z-index:1000;
        display:flex; align-items:center; justify-content:center;
        padding:20px; box-sizing:border-box;
      `;
      overlay.innerHTML = `
        <div id="knowMoreModal" style="
          background:var(--modal-bg, #111827); border:1px solid var(--modal-border, #1f2937);
          border-radius:16px; width:100%; max-width:680px;
          max-height:85vh; overflow-y:auto;
          padding:32px; box-sizing:border-box;
          position:relative; color:var(--modal-text, #f9fafb); font-family:inherit;
        ">
          <button id="knowMoreClose" style="
            position:absolute; top:16px; right:18px;
            background:none; border:none; color:var(--modal-text-dim, #9ca3af);
            font-size:22px; cursor:pointer; line-height:1;
          ">&#x2715;</button>
          <div id="knowMoreContent"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener("click", e => { if (e.target === overlay) overlay.style.display = "none"; });
      $("knowMoreClose").addEventListener("click", () => { overlay.style.display = "none"; });
    }

    const overlay = $("knowMoreOverlay");
    const content = $("knowMoreContent");
    overlay.style.display = "flex";

    content.innerHTML = `
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;color:var(--modal-accent, #a78bfa);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Job Breakdown</div>
        <h2 style="margin:0 0 4px;font-size:20px;color:var(--modal-text, #f9fafb);">${escHtml(jobData.title)}</h2>
        <p style="margin:0;color:var(--modal-text-dim, #9ca3af);font-size:14px;">${escHtml(jobData.company)} &nbsp;·&nbsp; ${escHtml(jobData.location)} &nbsp;·&nbsp; ${escHtml(jobData.salary)}</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;color:var(--modal-text-faint, #6b7280);font-size:14px;padding:20px 0;">
        <div style="width:20px;height:20px;border-radius:50%;border:2px solid var(--modal-accent, #a78bfa);border-top-color:transparent;animation:spin 0.8s linear infinite;flex-shrink:0;"></div>
        Analysing job description…
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;

    if (knowMoreCache[jobData.job_id]) {
      renderKnowMoreResult(content, jobData, knowMoreCache[jobData.job_id]);
      return;
    }

    let resumeSnippet = "";
    try {
      const snap = await getDoc(doc(db, "candidates", candidateId));
      if (snap.exists()) resumeSnippet = (snap.data().resume_text || "").slice(0, 800);
    } catch { /* proceed without resume context */ }

    const prompt = `You are a career coach helping a candidate understand a job and prepare for it.

Job Title: ${jobData.title}
Company: ${jobData.company}
Location: ${jobData.location}
Salary: ${jobData.salary}
Job Description:
${(jobData.description || "").slice(0, 1200)}

${resumeSnippet ? `Candidate Resume Snippet:\n${resumeSnippet}` : ""}

Return ONLY a raw JSON object, no markdown, no backticks:
{
  "summary": "2-3 sentence plain-English description of the role and what the company is looking for",
  "what_youll_do": ["bullet 1 (max 12 words)", "bullet 2", "bullet 3"],
  "tips": [
    { "title": "short tip title", "detail": "1 sentence personalised advice based on the resume" },
    { "title": "short tip title", "detail": "1 sentence advice" },
    { "title": "short tip title", "detail": "1 sentence advice" }
  ]
}`;

    try {
      let parsed = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await callGemini(prompt, "know_more");
          if (!raw?.trim()) throw new Error("Empty LLM response");
          const clean = raw.replace(/```json|```/g, "").trim();
          const jsonStr = clean.match(/\{[\s\S]*\}/)?.[0] || clean;
          parsed = JSON.parse(jsonStr);
          break;
        } catch {
          if (attempt === 0) {
            const note = document.createElement("p");
            note.id = "kmRetryNote";
            note.style.cssText = "color:var(--modal-text-dim, #9ca3af);font-size:12px;margin-top:8px;";
            note.textContent = "Taking longer than usual, retrying…";
            content.appendChild(note);
            await new Promise(r => setTimeout(r, 1500));
            $("kmRetryNote")?.remove();
          } else {
            throw new Error("Both LLM attempts failed");
          }
        }
      }
      knowMoreCache[jobData.job_id] = parsed;
      renderKnowMoreResult(content, jobData, parsed);
    } catch {
      content.innerHTML += `<p style="color:var(--red, #ef4444);font-size:13px;margin-top:12px;">Analysis failed — please close and try again.</p>`;
    }
  }

  function renderKnowMoreResult(content, jobData, data) {
    const tipsHTML = (data.tips || []).map((t, i) => `
      <div style="display:flex; gap:14px; align-items:flex-start; padding:12px 14px; background:var(--modal-bg-2, #0d1117); border-radius:10px; border:1px solid var(--modal-border, #1f2937);">
        <div style="min-width:26px; height:26px; border-radius:50%; background:linear-gradient(135deg,#4f46e5,#a78bfa); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; flex-shrink:0;">${i + 1}</div>
        <div>
          <div style="font-weight:600;font-size:13px;color:var(--modal-text, #f9fafb);margin-bottom:3px;">${escHtml(t.title)}</div>
          <div style="font-size:13px;color:var(--modal-text-dim, #9ca3af);line-height:1.5;">${escHtml(t.detail)}</div>
        </div>
      </div>
    `).join("");

    const doHTML = (data.what_youll_do || []).map(d => `
      <li style="color:var(--modal-text-body, #d1d5db);font-size:13px;margin-bottom:6px;line-height:1.5;">${escHtml(d)}</li>
    `).join("");

    content.innerHTML = `
      <div style="margin-bottom:22px;">
        <div style="font-size:11px;color:var(--modal-accent, #a78bfa);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Job Breakdown</div>
        <h2 style="margin:0 0 4px;font-size:20px;color:var(--modal-text, #f9fafb);">${escHtml(jobData.title)}</h2>
        <p style="margin:0;color:var(--modal-text-dim, #9ca3af);font-size:14px;">${escHtml(jobData.company)} &nbsp;·&nbsp; ${escHtml(jobData.location)} &nbsp;·&nbsp; ${escHtml(jobData.salary)}</p>
      </div>
      <div style="height:1px;background:var(--modal-border, #1f2937);margin-bottom:20px;"></div>
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;color:var(--modal-text-faint, #6b7280);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">About the Role</div>
        <p style="color:var(--modal-text-body, #d1d5db);font-size:14px;line-height:1.6;margin:0;">${escHtml(data.summary || "")}</p>
      </div>
      ${doHTML ? `
      <div style="margin-bottom:22px;">
        <div style="font-size:11px;color:var(--modal-text-faint, #6b7280);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">What You'll Do</div>
        <ul style="margin:0;padding-left:18px;">${doHTML}</ul>
      </div>` : ""}
      <div style="height:1px;background:var(--modal-border, #1f2937);margin-bottom:20px;"></div>
      <div style="margin-bottom:24px;">
        <div style="font-size:11px;color:var(--modal-accent, #a78bfa);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">✨ How to Prepare</div>
        <div style="display:flex;flex-direction:column;gap:10px;">${tipsHTML}</div>
      </div>
      ${safeUrl(jobData.apply_url) ? `
      <a href="${escAttr(safeUrl(jobData.apply_url))}" target="_blank" rel="noopener noreferrer" style="display:block; text-align:center; background:linear-gradient(135deg,#4f46e5,#a78bfa); color:#fff; font-weight:600; font-size:14px; padding:13px 24px; border-radius:10px; text-decoration:none; margin-top:4px;">Apply for this Role →</a>` : ""}
    `;
  }
}


/* =========================================================
   =================  LOCATEHIRE.HTML  =====================
   Candidate-facing job map. Green markers = matches.
========================================================= */
if ($("map") && $("cityPanel")) {
  let _matchedJobIds = new Set();
  let _entityMap = null;

  async function loadMatchedJobIds() {
    try {
      // SEC-17: the matched job ids are fetched each time instead of being kept
      // in browser storage.
      const user = await waitForAuth();
      if (!user) return;

      const snap = await getDoc(doc(db, "users", user.uid));
      const candidateId = snap.exists() ? (snap.data().latest_candidate_id || snap.data().candidate_id || null) : null;
      if (!candidateId) return;

      const { matches } = await getMatches({ candidate_id: candidateId, top_n: 50, offset: 0 });
      _matchedJobIds = new Set(matches.map(m => String(m.job_id)));
    } catch (e) {
      logError("locatehire matched ids failed", e);
    }
  }

  function buildTooltipHTML(jobs) {
    const country = resolveCountryLabel(jobs);
    const count = jobs.length;
    const matchCount = jobs.filter(j => _matchedJobIds.has(String(j.job_id))).length;
    const hasMatch = matchCount > 0;

    const accent      = hasMatch ? "#4ade80"               : "#7aa2ff";
    const accentDim    = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
    const accentLine   = hasMatch ? "rgba(74,222,128,0.18)": "rgba(122,162,255,0.18)";
    const accentRoleB  = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
    const accentRole   = hasMatch ? "rgba(74,222,128,0.05)": "rgba(122,162,255,0.05)";
    const textCol      = hasMatch ? "#b9ffd4"               : "#c8d8ff";

    const roleFreq = {};
    jobs.forEach(j => { if (j.title) roleFreq[j.title] = (roleFreq[j.title] || 0) + 1; });
    const topRoles = Object.entries(roleFreq).sort((a, b) => b[1] - a[1]).slice(0, 3);

    const rolesHTML = topRoles.map(([role, n]) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:${accentRole};border:1px solid ${accentRoleB};border-radius:6px;">
        <span style="font-size:11.5px;font-weight:600;color:${textCol};">${escHtml(role)}</span>
        <span style="font-size:10px;color:${accent};font-weight:700;margin-left:8px;">${n}</span>
      </div>`).join("");

    const withSal = jobs.filter(j => j.salary_min || j.salary_max);
    const avgSal = withSal.length
      ? Math.round(withSal.reduce((s, j) => s + (j.salary_max || j.salary_min || 0), 0) / withSal.length)
      : null;

    const salHTML = avgSal ? `
      <div style="margin-top:8px;padding:4px 8px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:10.5px;color:#6b7fa8;">Avg. salary</span>
        <span style="font-size:11.5px;font-weight:700;color:#4ade80;">~$${avgSal.toLocaleString()}</span>
      </div>` : "";

    const matchBadge = hasMatch ? `
      <div style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);border-radius:5px;padding:2px 7px;margin-bottom:8px;letter-spacing:0.05em;text-transform:uppercase;">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="#4ade80"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        ${matchCount} resume match${matchCount !== 1 ? "es" : ""}
      </div>` : "";

    return `
      <div style="background:#0b0e1a;border:1px solid ${accentLine};border-radius:12px;padding:12px 14px;width:220px;box-shadow:0 16px 48px rgba(0,0,0,0.7),inset 0 1px 0 rgba(122,162,255,0.08);font-family:'DM Sans',sans-serif;backdrop-filter:blur(12px);">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
          <div style="width:24px;height:24px;border-radius:7px;background:${accentDim};border:1px solid ${accentLine};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="${accent}"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:-0.01em;">${escHtml(country)}</div>
            <div style="font-size:10px;color:${accent};margin-top:1px;">${count} open position${count !== 1 ? "s" : ""}</div>
          </div>
        </div>
        ${matchBadge}
        <div style="height:1px;background:${accentRoleB};margin-bottom:8px;"></div>
        <div style="font-size:9.5px;font-weight:700;color:#4a5580;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Top Roles</div>
        <div style="display:flex;flex-direction:column;gap:4px;">${rolesHTML}</div>
        ${salHTML}
        <div style="margin-top:9px;text-align:right;font-size:10px;color:#3a4568;letter-spacing:0.03em;">Click to explore →</div>
      </div>`;
  }

  function showJobsForLocation(title, jobs) {
    const panel   = $("cityPanel");
    const grid    = $("panelGrid");
    const heading = $("panelTitle");
    const count   = $("panelCount");

    panel.classList.remove("hidden");
    heading.textContent = title;

    const matched   = jobs.filter(j =>  _matchedJobIds.has(String(j.job_id)));
    const unmatched = jobs.filter(j => !_matchedJobIds.has(String(j.job_id)));
    const ordered   = [...matched, ...unmatched];

    if (count) {
      count.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} available${matched.length ? ` · ${matched.length} matched` : ""}`;
    }

    grid.innerHTML = "";

    if (!jobs.length) {
      grid.innerHTML = `
        <div class="panel-placeholder">
          <div class="placeholder-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <h4>No jobs here</h4>
          <p>No openings available for this location right now.</p>
        </div>`;
      return;
    }

    if (matched.length > 0 && unmatched.length > 0) {
      grid.innerHTML += `
        <div class="panel-section-divider panel-section-matched">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--green, #4ade80)" style="vertical-align:-1px;margin-right:4px;">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          Resume Matches
        </div>`;
    }

    ordered.forEach((job, i) => {
      const isMatch  = _matchedJobIds.has(String(job.job_id));
      const location = job.location_display || job.location || job.city || "Location not specified";
      const applyHref = safeUrl(job.apply_url);
      const hasApply = !!applyHref;

      if (!isMatch && matched.length > 0 && i === matched.length) {
        grid.innerHTML += `<div class="panel-section-divider" style="margin-top:6px;">Other Jobs</div>`;
      }

      const matchBadge = isMatch ? `
        <div class="panel-match-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--green, #4ade80)"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Resume Match
        </div>` : "";

      grid.innerHTML += `
        <div class="panel-job-card${isMatch ? " panel-job-matched" : ""}" style="animation-delay:${i * 45}ms">
          ${matchBadge}
          <div class="panel-job-title">${escHtml(job.title || "Job Role")}</div>
          <div class="panel-job-company">${escHtml(job.company || "Company not available")}</div>
          <div class="panel-job-meta">
            <span class="panel-job-loc">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
              </svg>
              ${escHtml(location)}
            </span>
            ${job.source ? `<span class="panel-job-source">${escHtml(job.source)}</span>` : ""}
          </div>
          ${hasApply ? `
            <a class="panel-apply-btn" href="${escAttr(applyHref)}" target="_blank" rel="noopener noreferrer">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Apply Now
            </a>` : ""}
        </div>`;
    });
  }

  window.closeCityPanel = function () {
    $("cityPanel")?.classList.add("hidden");
    const grid = $("panelGrid");
    if (grid) grid.innerHTML = "";
  };

  async function loadJobsAndMarkers() {
    const matchPromise = loadMatchedJobIds();
    const jobs = await getJobs();
    if (!jobs.length) return;

    _entityMap = createEntityMap({
      containerId: "map",
      getEntityId: j => String(j.job_id),
      getLocationKey: j => j.city || j.location_display || "Jobs",
      getLatLng: j => (j.lat && j.lng) ? { lat: j.lat, lng: j.lng } : null,
      getLocationString: j => j.location_display || j.location ||
        (j.city && j.country ? `${j.city}, ${j.country}` : j.city || j.country || null),
      buildTooltipHTML,
      onMarkerClick: showJobsForLocation,
      matchedIds: _matchedJobIds
    });

    await _entityMap.addEntities(jobs);
    await matchPromise;
    _entityMap.refreshMarkerStyles(_matchedJobIds);
  }

  loadJobsAndMarkers();
}


/* =========================================================
   ==================  SAVEDJOBS.HTML  =====================
========================================================= */
if ($("savedJobsGrid")) {
  // Instant skeleton placeholder, shown immediately on page load before
  // Firestore data arrives (previously a separate inline script in
  // savedjobs.html, not part of savedjobs.js).
  (function showInstantSkeletons() {
    const grid = $("savedJobsGrid");
    function skel() {
      return `
        <div class="skeleton-saved-card">
          <div style="display:flex;flex-direction:column;gap:10px;">
            <div class="sk" style="width:60%;height:16px;"></div>
            <div class="sk" style="width:38%;height:12px;"></div>
            <div style="display:flex;gap:7px;">
              <div class="sk" style="width:90px;height:22px;border-radius:6px;"></div>
              <div class="sk" style="width:80px;height:22px;border-radius:6px;"></div>
            </div>
            <div class="sk" style="width:30%;height:13px;"></div>
            <div style="height:1px;background:rgba(122,162,255,0.07);margin:4px -20px;"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
              <div class="sk" style="height:34px;border-radius:8px;"></div>
              <div class="sk" style="height:34px;border-radius:8px;"></div>
            </div>
          </div>
        </div>`;
    }
    grid.innerHTML = Array(6).fill(null).map(skel).join("");
  })();


  const EMPTY_STATE_HTML = `
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <h4>No saved jobs yet</h4>
      <p>Head to <a href="jobmatches.html">Job Matches</a> and bookmark roles you like.</p>
    </div>`;

  function updateSavedCount(countEl, grid) {
    if (!countEl) return;
    const n = grid.querySelectorAll(".saved-card").length;
    countEl.textContent = n ? `${n} saved job${n === 1 ? "" : "s"}` : "";
  }

  async function loadSavedJobs() {
    const user = auth.currentUser;
    if (!user) return;

    const grid  = $("savedJobsGrid");
    const count = $("savedCount");

    const q = query(collection(db, "saved_jobs"), where("user_id", "==", user.uid));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      grid.innerHTML = EMPTY_STATE_HTML;
      if (count) count.textContent = "";
      return;
    }

    if (count) {
      const n = snapshot.size;
      count.textContent = `${n} saved job${n === 1 ? "" : "s"}`;
    }

    grid.innerHTML = "";

    snapshot.forEach((docSnap, idx) => {
      const job = docSnap.data();
      const applyUrl = job.apply_url || job.apply_link || "";
      const applyHref = safeUrl(applyUrl);
      const hasApply = !!applyHref;
      const salary = formatSalary(job);
      const location = job.location || "Location not specified";

      const card = document.createElement("div");
      card.className = "saved-card";
      card.style.animationDelay = `${idx * 55}ms`;
      card.dataset.docid = docSnap.id;

      card.innerHTML = `
        <svg class="saved-bookmark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="saved-card-title">${escHtml(job.title || "Job Role")}</div>
        <div class="saved-card-company">${escHtml(job.company || "Company not available")}</div>
        <div class="saved-meta">
          <span class="meta-chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            ${escHtml(location)}
          </span>
        </div>
        <div class="saved-salary">${escHtml(salary)}</div>
        <div class="card-divider"></div>
        <div class="saved-actions">
          ${hasApply
            ? `<a href="${escAttr(applyHref)}" target="_blank" rel="noopener noreferrer" class="saved-btn apply">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                   <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                   <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                 </svg>
                 Apply
               </a>`
            : `<button class="saved-btn apply disabled" disabled>
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                   <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                   <polyline points="15 3 21 3 21 9"/>
                 </svg>
                 Apply
               </button>`
          }
          <button class="saved-btn remove" onclick="removeSavedJob(this.closest('.saved-card').dataset.docid, this)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
            Remove
          </button>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  async function removeSavedJob(docId, btn) {
    const card = btn?.closest(".saved-card");
    if (card) {
      card.classList.add("removing");
      await new Promise(r => setTimeout(r, 260));
      card.remove();
    }

    await deleteDoc(doc(db, "saved_jobs", docId));

    const grid  = $("savedJobsGrid");
    const count = $("savedCount");

    if (!grid.querySelectorAll(".saved-card").length) {
      grid.innerHTML = EMPTY_STATE_HTML;
      if (count) count.textContent = "";
    } else {
      updateSavedCount(count, grid);
    }
  }
  window.removeSavedJob = removeSavedJob;

  onAuthStateChanged(auth, (user) => { if (user) loadSavedJobs(); });
}


/* =========================================================
   ===================  RESUME.HTML  =======================
   Resume upload, versioning, and AI ATS-style analysis.
========================================================= */
if ($("dropZone") && $("analyzeBtn")) {
  window._resumeText    = "";
  window._candidateId   = "";
  window._candidateName = "";

  function setStatus(msg, type = "info") {
    const el = $("autoStatusMsg");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    el.style.color       = type === "warn" ? "var(--amber, #fbbf24)" : type === "success" ? "var(--green, #4ade80)" : "var(--text-2, #9bb3ff)";
    el.style.borderColor = type === "warn" ? "rgba(251,191,36,0.2)" : type === "success" ? "rgba(34,197,94,0.2)" : "rgba(122,162,255,0.15)";
    el.style.background  = type === "warn" ? "rgba(251,191,36,0.06)" : type === "success" ? "rgba(34,197,94,0.06)" : "rgba(122,162,255,0.07)";
  }
  function clearStatus() { const el = $("autoStatusMsg"); if (el) el.style.display = "none"; }
  function showCurrentBar(name) {
    $("currentResumeBar").style.display = "flex";
    $("currentResumeName").textContent  = name;
  }
  function highlightUploadCard() {
    const card = $("uploadCard");
    if (!card) return;
    const light = document.documentElement.getAttribute("data-theme") === "light";
    card.style.border = "1px solid rgba(251,191,36,0.45)";
    card.style.background = light
      ? "linear-gradient(145deg, rgba(251,191,36,0.08), rgba(251,191,36,0.03))"
      : "linear-gradient(145deg, #1c1e2e, #141628)";
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    $("analyzeBtn").textContent = "Save & Analyze Resume";
  }
  function resetUploadCard() {
    const card = $("uploadCard");
    if (!card) return;
    card.style.border = "";
    card.style.background = "";
    $("analyzeBtn").textContent = "Re-analyze Resume";
  }

  async function findLatestCandidateDoc(user) {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    let knownCandidateId = null;

    if (userSnap.exists()) {
      const ud = userSnap.data();
      window._candidateName = ud.name || user.email.split("@")[0];
      knownCandidateId = ud.latest_candidate_id || ud.candidate_id || null;

      if (knownCandidateId) {
        const cs = await getDoc(doc(db, "candidates", knownCandidateId));
        if (cs.exists()) return { id: cs.id, ...cs.data() };

        // Self-heal: users doc points to a missing candidates doc
        const healDoc = {
          candidate_id: knownCandidateId,
          name: ud.name || user.email.split("@")[0],
          email: user.email,
          user_id: user.uid,
          applied_role: "General",
          resume_text: "",
          is_latest: true,
          createdAt: serverTimestamp()
        };
        try {
          await setDoc(doc(db, "candidates", knownCandidateId), healDoc);
          return { id: knownCandidateId, ...healDoc };
        } catch { /* fall through to query below */ }
      }
    }

    let allDocs = [];
    try {
      const q1 = query(collection(db, "candidates"), where("user_id", "==", user.uid), orderBy("createdAt", "desc"), limit(10));
      const s1 = await getDocs(q1);
      s1.forEach(d => allDocs.push({ id: d.id, ...d.data() }));
    } catch { /* composite index may not exist yet */ }

    if (!allDocs.length) {
      try {
        const q2 = query(collection(db, "candidates"), where("email", "==", user.email));
        const s2 = await getDocs(q2);
        s2.forEach(d => allDocs.push({ id: d.id, ...d.data() }));
        allDocs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      } catch { /* silent */ }
    }

    if (allDocs.length) {
      const latest = allDocs.find(d => d.is_latest) || allDocs[0];
      await setDoc(doc(db, "users", user.uid), {
        latest_candidate_id: latest.id,
        candidate_id: latest.id
      }, { merge: true });
      return latest;
    }
    return null;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    setStatus("Loading your profile…");
    try {
      window._candidateName = user.email?.split("@")[0] || "You";
      const latest = await findLatestCandidateDoc(user);

      if (!latest) {
        setStatus("No profile yet. Upload your resume below to get started.", "warn");
        highlightUploadCard();
        return;
      }

      window._candidateId   = latest.id;
      window._candidateName = latest.name || window._candidateName;

      if (latest.resume_text?.trim()) {
        window._resumeText = latest.resume_text;
        showCurrentBar(window._candidateName + (latest.version ? ` (v${latest.version})` : ""));
        setStatus("Resume found. Running analysis…");
        await runAnalysis(latest.resume_text);
        clearStatus();
      } else {
        setStatus("Your signup resume wasn't saved — please re-upload it below.", "warn");
        highlightUploadCard();
      }
    } catch {
      setStatus("Could not load your profile. Upload your resume below.", "warn");
      highlightUploadCard();
    }
  });

  const dropZone = $("dropZone");
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  $("resumeFile").addEventListener("change", e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
  $("removeFile").addEventListener("click", () => {
    $("resumeFile").value = "";
    $("fileInfo").classList.remove("show");
    $("parseStatus").classList.remove("show");
    $("analyzeBtn").disabled = true;
  });

  async function handleFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "doc", "docx"].includes(ext)) {
      showToast("Please upload a PDF or DOCX file.", "error");
      return;
    }
    $("fileName").textContent = file.name;
    $("fileInfo").classList.add("show");
    $("parseStatus").classList.add("show");
    $("analyzeBtn").disabled = true;
    try {
      // NOTE: legacy .doc files are no longer specially handled — the
      // shared parser (utils.js) supports pdf/docx only, matching every
      // other resume upload point in the app (signup, bulk lead matching).
      // A .doc upload will now report "unsupported" instead of attempting
      // (and likely failing) a docx-parser pass against it.
      window._resumeText = await parseResumeFile(file);
      $("parseStatus").classList.remove("show");
      $("analyzeBtn").disabled = false;
    } catch {
      showToast("Failed to parse the file.", "error");
      $("parseStatus").classList.remove("show");
    }
  }

  $("analyzeBtn").addEventListener("click", async () => {
    const text = window._resumeText;
    if (!text.trim()) { showToast("Please upload a resume file first.", "warning"); return; }

    const btn = $("analyzeBtn");
    btn.disabled = true;

    const newId = await saveNewResumeVersion(text);
    if (newId) {
      window._candidateId = newId;
      showCurrentBar(window._candidateName + " (latest)");
    }

    resetUploadCard();
    clearStatus();

    try {
      await runAnalysis(text);
    } catch {
      showToast("Analysis failed. Please try again.", "error");
    } finally {
      btn.disabled = false;
    }
  });

  async function saveNewResumeVersion(text) {
    const user = auth.currentUser;
    if (!user) return null;

    const name = window._candidateName || user.email.split("@")[0];
    // Uses the single canonical inferRoleFromResume (utils.js) rather than
    // this page's previous private keyword list, which was missing the
    // "Software Engineer" category entirely — see batch notes.
    const appliedRole = inferRoleFromResume(text);
    let newCandidateId = null;

    const currentId = window._candidateId || "";
    if (currentId.startsWith("local_") && currentId.includes(user.uid)) {
      try {
        await setDoc(doc(db, "candidates", currentId), {
          resume_text: text, applied_role: appliedRole, is_latest: true
        }, { merge: true });
        await setDoc(doc(db, "users", user.uid), {
          latest_candidate_id: currentId, candidate_id: currentId
        }, { merge: true });
        return currentId;
      } catch { /* fall through to new doc */ }
    }

    newCandidateId = await registerCandidate({ name, email: user.email, resume_text: text }, 5000);
    if (!newCandidateId) newCandidateId = `local_${user.uid}_${Date.now()}`;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "candidates", newCandidateId), {
        candidate_id: newCandidateId, name, email: user.email, user_id: user.uid,
        resume_text: text, applied_role: appliedRole, is_latest: true, createdAt: serverTimestamp()
      });
      if (window._candidateId && window._candidateId !== newCandidateId) {
        batch.update(doc(db, "candidates", window._candidateId), { is_latest: false });
      }
      batch.set(doc(db, "users", user.uid), {
        latest_candidate_id: newCandidateId, candidate_id: newCandidateId
      }, { merge: true });
      await batch.commit();
      return newCandidateId;
    } catch {
      showToast("Failed to save resume. Please try again.", "error");
      return null;
    }
  }

  async function runAnalysis(text) {
    $("analyzingOverlay").classList.add("show");
    try {
      const prompt = `You are an expert ATS analyzer and career coach.

Analyze this resume and return ONLY a valid JSON object. No markdown, no backticks, no explanation.

{
  "score": <number 0-100>,
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weaknesses": ["weakness 1", "weakness 2", "weakness 3"],
  "missing_keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
  "found_keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
  "skill_breakdown": [
    {"name": "Technical Skills",  "score": 80},
    {"name": "Experience Depth",  "score": 65},
    {"name": "Keyword Density",   "score": 70},
    {"name": "Formatting",        "score": 85}
  ],
  "suggestions": ["suggestion 1", "suggestion 2", "suggestion 3"]
}

Resume:
${text.slice(0, 4000)}`;

      const raw = await callGemini(prompt, "resume_analysis");
      if (!raw) throw new Error("Empty LLM response");
      const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
      renderResults(result);
    } finally {
      $("analyzingOverlay").classList.remove("show");
    }
  }

  function renderResults(d) {
    const score = Math.max(0, Math.min(100, d.score || 0));
    $("atsScore").textContent = score + "%";
    $("gaugeFill").style.strokeDashoffset = 226 - (score / 100) * 226;

    let cls = "badge-poor", lbl = "Needs Work";
    if      (score >= 85) { cls = "badge-excellent"; lbl = "Excellent"; }
    else if (score >= 70) { cls = "badge-good";      lbl = "Good Match"; }
    else if (score >= 50) { cls = "badge-fair";       lbl = "Fair"; }
    $("scoreBadge").innerHTML = `<span class="score-badge ${cls}">${lbl}</span>`;

    const colors = ["var(--blue, #7aa2ff)", "var(--green, #4ade80)", "var(--amber, #fbbf24)", "var(--purple, #c084fc)"];
    const barsEl = $("skillBars");
    barsEl.innerHTML = (d.skill_breakdown || []).map((s, i) => `
      <div class="skill-row">
        <label>${escHtml(s.name)}<span>${escHtml(s.score)}%</span></label>
        <div class="skill-track">
          <div class="skill-fill" style="background:${colors[i % colors.length]};" data-target="${escAttr(s.score)}"></div>
        </div>
      </div>`).join("");
    setTimeout(() => {
      barsEl.querySelectorAll(".skill-fill").forEach(el => el.style.width = el.dataset.target + "%");
    }, 80);

    $("insightsPlaceholder").style.display = "none";
    $("insightsGrid").style.display = "grid";
    $("strengthsList").innerHTML  = (d.strengths  || []).map(s => `<li>${escHtml(s)}</li>`).join("");
    $("weaknessesList").innerHTML = (d.weaknesses || []).map(w => `<li>${escHtml(w)}</li>`).join("");

    $("kwPlaceholder").style.display = "none";
    $("kwContent").style.display = "block";
    $("missingTags").innerHTML = (d.missing_keywords || []).map(k => `<span class="kw-tag">${escHtml(k)}</span>`).join("");
    $("foundTags").innerHTML   = (d.found_keywords   || []).map(k => `<span class="kw-tag">${escHtml(k)}</span>`).join("");

    $("sugPlaceholder").style.display = "none";
    $("suggestionsList").innerHTML = (d.suggestions || []).map(s =>
      `<div class="suggestion-item"><div class="sug-dot"></div><span>${escHtml(s)}</span></div>`).join("");
  }
}


/* =========================================================
   ================  CAND_ACTIONS.HTML  ====================
   "My Applications" — status pipeline, detail modal, and
   recruiter-update notifications.
========================================================= */
if ($("appContainer")) {
  // Skeleton placeholder while applications load
  (function () {
    const grid = $("appContainer");
    function skel() {
      return `
        <div class="skeleton-candidate-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
            <div class="skeleton-title" style="width:60%;height:16px;"></div>
            <div class="skeleton-chip" style="width:80px;height:22px;border-radius:20px;"></div>
          </div>
          <div class="skeleton-subtitle" style="width:40%;height:12px;margin-bottom:8px;"></div>
          <div style="display:flex;gap:3px;margin-bottom:14px;">
            ${Array(5).fill('<div class="skeleton-chip" style="width:100%;height:3px;border-radius:2px;"></div>').join('')}
          </div>
          <div style="display:flex;gap:8px;">
            <div class="skeleton-btn" style="width:100px;"></div>
            <div class="skeleton-btn" style="width:80px;"></div>
          </div>
        </div>`;
    }
    grid.innerHTML = Array(4).fill(null).map(skel).join("");
  })();

  let allApps = [];
  let activeStatus = "all";
  let currentUserUid = null;

  const STATUSES = ["applied", "reviewing", "shortlisted", "interview", "hired", "rejected"];
  const STATUS_LABELS = {
    applied: "Applied", reviewing: "Reviewing", shortlisted: "Shortlisted",
    interview: "Interview", hired: "Hired", rejected: "Rejected"
  };
  const PIPELINE_STEPS = ["applied", "reviewing", "shortlisted", "interview", "hired"];

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const userSnap = await getDoc(doc(db, "users", user.uid)).catch(() => null);
    if (!userSnap?.exists()) return;
    const candidateId = userSnap.data().candidate_id || userSnap.data().latest_candidate_id;
    if (!candidateId) return;

    currentUserUid = user.uid;
    loadApplications(user.uid);
    subscribeNotifications(user.uid);
  });

  function loadApplications(userUid) {
    const q = query(
      collection(db, "applications"),
      where("candidate_user_id", "==", userUid),
      orderBy("applied_at", "desc")
    );

    onSnapshot(q, async (snap) => {
      const apps = [];
      const jobCache = {};

      for (const docSnap of snap.docs) {
        const d = docSnap.data();
        const fsDocId = d.job_firestore_id || d.job_id;
        if (!jobCache[fsDocId]) {
          try {
            let jSnap = await getDoc(doc(db, "posted_jobs", fsDocId));
            if (jSnap.exists()) {
              jobCache[fsDocId] = jSnap.data();
            } else {
              const fieldQ = query(collection(db, "posted_jobs"), where("job_id", "==", d.job_id));
              const fieldSnap = await getDocs(fieldQ);
              jobCache[fsDocId] = fieldSnap.empty ? null : fieldSnap.docs[0].data();
            }
          } catch { jobCache[fsDocId] = null; }
        }
        const jd = jobCache[fsDocId];
        apps.push({
          id: docSnap.id, ...d, jobData: jd,
          jobTitle: jd?.title || d.job_title || "Job",
          company: jd?.organisation_name || jd?.company || jd?.company_name || d.company_name || d.company || "",
          location: jd?.location || d.location || ""
        });
      }

      allApps = apps;
      updateCounts();
      renderCards();
    });
  }

  function updateCounts() {
    $("cnt-all").textContent = allApps.length;
    STATUSES.forEach(s => {
      const el = $(`cnt-${s}`);
      if (el) el.textContent = allApps.filter(a => a.status === s).length;
    });
  }

  function renderCards() {
    const container = $("appContainer");
    let apps = allApps;
    if (activeStatus !== "all") apps = apps.filter(a => a.status === activeStatus);

    if (!apps.length) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:16px;opacity:.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
          <h3>${activeStatus === "all" ? "You haven't applied to any jobs yet" : `No applications in "${escHtml(STATUS_LABELS[activeStatus])}"`}</h3>
          <p>Browse matched jobs and click Apply to get started.</p>
          <a href="jobmatches.html" class="empty-cta">Browse Job Matches →</a>
        </div>`;
      return;
    }
    container.innerHTML = apps.map(app => buildCard(app)).join("");
  }

  function buildCard(app) {
    const status = app.status || "applied";
    const chipClass = `chip-${escAttr(status)}`;
    const timeAgo = app.applied_at?.toDate ? timeSince(app.applied_at.toDate()) : "Recently";
    const isNew = app.cand_unread;
    const rejected = status === "rejected";
    const progressHTML = !rejected ? buildProgress(status) : "";
    const notePreview = app.note ? `<div class="app-note-preview">💬 ${escHtml(app.note)}</div>` : "";

    return `
      <div class="app-card ${isNew ? "unread" : ""}" data-id="${escAttr(app.id)}" onclick="openDetail(this.dataset.id)" style="cursor:pointer;">
        <div class="app-card-top">
          <div>
            <div class="app-cand-name">${escHtml(app.jobTitle)}</div>
            <div class="app-cand-role">${app.company ? escHtml(app.company) : ""}${app.company && app.location ? " · " : ""}${app.location ? escHtml(app.location) : ""}</div>
          </div>
          <span class="app-status-chip ${chipClass}">${escHtml(STATUS_LABELS[status])}</span>
        </div>
        ${progressHTML}
        <div class="app-meta">
          <span>📅 Applied ${timeAgo}</span>
          ${app.company ? `<span>🏢 ${escHtml(app.company)}</span>` : ""}
        </div>
        ${notePreview}
        ${status === "interview" ? `<div style="background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.2);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--cyan, #38bdf8);">🎉 You've been selected for an interview!</div>` : ""}
        ${status === "hired" ? `<div style="background:rgba(74,222,128,.06);border:1px solid rgba(74,222,128,.2);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--green, #4ade80);font-weight:600;">🎊 Congratulations! You've been hired.</div>` : ""}
        ${rejected ? `<div style="background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.15);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--red, #f87171);">This application was not successful. Keep applying!</div>` : ""}
        <div class="app-actions" onclick="event.stopPropagation()">
          <button class="app-btn" onclick="openDetail(this.closest('.app-card').dataset.id)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            View Details
          </button>
          ${safeMailto(app.recruiter_email || app.company_email, `Re: My application for ${app.jobTitle || ""}`) ? `
          <button class="app-btn success" data-mailto="${escAttr(safeMailto(app.recruiter_email || app.company_email, `Re: My application for ${app.jobTitle || ""}`))}" onclick="window.location.href=this.dataset.mailto">
            ✉ Reach Out
          </button>` : ""}
        </div>
      </div>`;
  }

  function buildProgress(currentStatus) {
    const steps = PIPELINE_STEPS;
    const ci = steps.indexOf(currentStatus);
    const dots = steps.map((s, i) => {
      let cls = "pp-step";
      if (i < ci) cls += " done";
      if (i === ci) cls += " current";
      return `<div class="${cls}" title="${escAttr(STATUS_LABELS[s])}"></div>`;
    }).join("");
    return `<div class="pipeline-progress">${dots}</div>`;
  }

  window.openDetail = async function (appId) {
    const app = allApps.find(a => a.id === appId);
    if (!app) return;

    if (app.cand_unread) {
      await updateDoc(doc(db, "applications", appId), { cand_unread: false }).catch(() => {});
      app.cand_unread = false;
      document.querySelector(`.app-card[data-id="${CSS.escape(String(appId))}"]`)?.classList.remove("unread");
    }

    const overlay = $("detailOverlay");
    const content = $("detailContent");
    overlay.style.display = "flex";

    const status = app.status || "applied";
    const history = app.status_history || [];

    const timelineHTML = history.length
      ? history.map(h => `
          <div class="tl-item">
            <div class="tl-dot" style="color:${statusColor(h.status)}">${statusIcon(h.status)}</div>
            <div class="tl-body">
              <div class="tl-label">${escHtml(STATUS_LABELS[h.status] || h.status)}</div>
              <div class="tl-time">${h.at?.toDate ? timeSince(h.at.toDate()) : ""}</div>
              ${h.note ? `<div class="tl-note">"${escHtml(h.note)}"</div>` : ""}
            </div>
          </div>`).join("")
      : `<div class="tl-item">
          <div class="tl-dot" style="color:${statusColor(status)}">${statusIcon(status)}</div>
          <div class="tl-body">
            <div class="tl-label">${escHtml(STATUS_LABELS[status])}</div>
            <div class="tl-time">Current status</div>
          </div>
        </div>`;

    const appliedDate = app.applied_at?.toDate
      ? app.applied_at.toDate().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "Unknown";

    content.innerHTML = `
      <h2 style="margin:0 0 4px;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(app.jobTitle)}</h2>
      <p style="margin:0 0 20px;color:var(--text-3, #6b7fa8);font-size:13px;">
        ${app.company ? `<span style="color:var(--text-2, #a0aec0);font-weight:600;">${escHtml(app.company)}</span>` : ""}${app.company && app.location ? " · " : ""}${app.location ? escHtml(app.location) : ""}
      </p>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
        <span class="app-status-chip chip-${escAttr(status)}">${escHtml(STATUS_LABELS[status])}</span>
        <span style="font-size:12px;color:var(--text-muted, #4a5580);">Applied ${appliedDate}</span>
      </div>
      ${status !== "rejected" ? buildProgress(status) : ""}
      ${status !== "rejected" ? '<div style="height:18px;"></div>' : ""}
      <div class="prof-row">
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div class="prof-field" style="flex:1;min-width:120px;">
            <label>Job Title</label>
            <p>${escHtml(app.jobTitle)}</p>
          </div>
          ${app.company ? `
          <div class="prof-field" style="flex:1;min-width:120px;">
            <label>Company</label>
            <p>${escHtml(app.company)}</p>
          </div>` : ""}
        </div>
        ${app.location ? `
        <div class="prof-field">
          <label>Location</label>
          <p>${escHtml(app.location)}</p>
        </div>` : ""}
      </div>
      ${app.note ? `
      <div style="margin-bottom:18px;">
        <div class="prof-field"><label>Your Cover Note</label></div>
        <div class="app-note-preview" style="white-space:normal;font-size:13px;padding:10px 14px;">
          ${escHtml(app.note)}
        </div>
      </div>` : ""}
      ${app.jobData?.description ? `
      <div style="margin-bottom:18px;">
        <div class="prof-field"><label>Job Description</label></div>
        <div style="background:var(--surface, #090e1c);border:1px solid rgba(122,162,255,.1);border-radius:10px; padding:12px 14px;font-size:12px;color:var(--text-2, #a0aec0);line-height:1.6;max-height:120px;overflow-y:auto;">
          ${escHtml((app.jobData.description || "").slice(0, 500))}${(app.jobData.description || "").length > 500 ? "…" : ""}
        </div>
      </div>` : ""}
      ${status === "interview" ? `<div style="background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.2); border-radius:8px;padding:12px 14px;font-size:13px;color:var(--cyan, #38bdf8);margin-bottom:18px;">🎉 You've been selected for an interview! The recruiter will reach out with details.</div>` : ""}
      ${status === "hired" ? `<div style="background:rgba(74,222,128,.06);border:1px solid rgba(74,222,128,.2); border-radius:8px;padding:12px 14px;font-size:13px;color:var(--green, #4ade80);font-weight:600;margin-bottom:18px;">🎊 Congratulations! You've been hired for this role.</div>` : ""}
      ${status === "rejected" ? `<div style="background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.15); border-radius:8px;padding:12px 14px;font-size:13px;color:var(--red, #f87171);margin-bottom:18px;">This application was not successful. Don't give up — keep applying!</div>` : ""}
      <div style="height:1px;background:rgba(122,162,255,.08);margin-bottom:18px;"></div>
      <div class="prof-field" style="margin-bottom:12px;"><label>Application Timeline</label></div>
      <div class="timeline">${timelineHTML}</div>
      <div class="bm-btn-row" style="margin-top:20px;">
        ${safeMailto(app.recruiter_email || app.company_email, `Re: My application for ${app.jobTitle || ""}`) ? `
        <button class="bm-btn" data-mailto="${escAttr(safeMailto(app.recruiter_email || app.company_email, `Re: My application for ${app.jobTitle || ""}`))}" onclick="window.location.href=this.dataset.mailto">
          ✉ Email Recruiter
        </button>` : ""}
        <button class="bm-btn primary" onclick="document.getElementById('detailOverlay').style.display='none'">
          Close
        </button>
      </div>
    `;
  };

  window.closeDetailModal = function (e) {
    if (e.target === $("detailOverlay")) $("detailOverlay").style.display = "none";
  };

  function subscribeNotifications(userUid) {
    const q = query(
      collection(db, "notifications"),
      where("to_user_id", "==", userUid),
      where("to_role", "==", "candidate"),
      orderBy("created_at", "desc"),
      limit(30)
    );

    onSnapshot(q, (snap) => {
      const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const unread = notifs.filter(n => !n.read).length;

      const badge = $("notifBadge");
      badge.textContent = unread;
      badge.style.display = unread ? "flex" : "none";

      const list = $("notifList");
      if (!notifs.length) {
        list.innerHTML = '<div class="notif-empty">No updates from recruiters yet.</div>';
        return;
      }
      list.innerHTML = notifs.map(n => {
        const time = n.created_at?.toDate ? timeSince(n.created_at.toDate()) : "Recently";
        if (n.type === "invite_to_apply") {
          return `
            <div class="notif-item ${n.read ? "" : "unread"}" data-id="${escAttr(n.id)}" onclick="markNotifRead(this.dataset.id)">
              <div>
                <strong>${escHtml(n.recruiter_name || "A recruiter")}</strong> invited you to apply for
                <strong>${escHtml(n.job_title || "a job")}</strong>.
                ${n.message && n.message !== `${n.recruiter_name || "A recruiter"} invited you to apply for "${n.job_title}".`
                  ? `<div style="margin-top:5px;font-size:12px;color:var(--text-3, #6b7fa8);font-style:italic;">"${escHtml(n.message)}"</div>` : ""}
              </div>
              ${safeUrl(n.apply_url) ? `
              <a href="${escAttr(safeUrl(n.apply_url))}" onclick="event.stopPropagation();markNotifRead(this.closest('.notif-item').dataset.id)"
                 style="display:inline-flex;align-items:center;gap:5px;margin-top:8px; font-size:12px;font-weight:600;color:var(--green, #4ade80);text-decoration:none; background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.2); padding:5px 11px;border-radius:7px;transition:background .15s;"
                 onmouseover="this.style.background='rgba(74,222,128,.16)'"
                 onmouseout="this.style.background='rgba(74,222,128,.08)'">
                🚀 Apply Now
              </a>` : ""}
              <div class="notif-time">${escHtml(time)}</div>
            </div>`;
        }
        return `
          <div class="notif-item ${n.read ? "" : "unread"}" data-id="${escAttr(n.id)}" onclick="markNotifRead(this.dataset.id)">
            <div>
              Your application for <strong>${escHtml(n.job_title || "a job")}</strong> was updated to
              <span class="notif-status" style="color:${statusColor(n.new_status)}">${escHtml(STATUS_LABELS[n.new_status] || n.new_status || "")}</span>.
            </div>
            <div class="notif-time">${escHtml(time)}</div>
          </div>`;
      }).join("");
    });
  }

  window.markNotifRead = async function (notifId) {
    await updateDoc(doc(db, "notifications", notifId), { read: true }).catch(() => {});
  };
  window.markAllRead = async function () {
    if (!currentUserUid) return;
    const q = query(collection(db, "notifications"), where("to_user_id", "==", currentUserUid), where("read", "==", false));
    const snap = await getDocs(q).catch(() => null);
    if (!snap) return;
    snap.docs.forEach(d => updateDoc(d.ref, { read: true }).catch(() => {}));
  };

  $("pipelineTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".ptab");
    if (!btn) return;
    document.querySelectorAll(".ptab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeStatus = btn.dataset.status;
    renderCards();
  });

  checkApplyUrlParam();
}
