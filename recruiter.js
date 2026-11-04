/* =========================================================
   RECRUITER.JS
   Covers every recruiter-facing page:
     rec-dash.html · rec-jobs.html · rec-postjob.html
     rec-actions.html · rec-leads.html · rec-locatehire.html
     cand-matches.html
   Each section below only runs if that page's DOM elements are
   present, so one module can safely load on every recruiter page.
========================================================= */

import {
  collection, getDocs, getDoc, addDoc, updateDoc, doc, query, where,
  onSnapshot, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { auth, db } from "./config.js";
import {
  getJobs, getJobsByCompany, getJobsByCountry, getMatches, postJob,
  registerRecruiter, getEmbedToken, getCompanyContacts
} from "./api.js";





import { callGemini } from "./gemini.js";
import { embedPowerBI } from "./powerbi.js";
import {
  showToast, showErrorBanner, setProgress, logError,
  formatSalary, escHtml, escAttr, decodeAttr, safeUrl, safeMailto, timeSince, statusColor, statusIcon,
  parseDocumentWithLayout, parseResumeFile, createEntityMap, resolveCountryLabel, getRegionLabel
} from "./utils.js";

const $ = id => document.getElementById(id);

// Jobs posted via rec-postjob.html store `created_at` as a Firestore
// serverTimestamp() — once read back that's a Timestamp instance (or a
// plain {seconds,nanoseconds} object from some code paths), NOT a string
// or number. `new Date(timestampObject)` silently produces an Invalid
// Date, so every "newest"/"oldest" sort comparison evaluated to NaN and
// silently no-opped for internally-posted jobs. This normalizes any of
// the shapes created_at can actually take into a comparable epoch ms.
function toSortableDate(v) {
  if (!v) return 0;
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}


/* =========================================================
   SHARED STATE
   orgJobs is populated by whichever page loads it first
   (cand-matches.html or rec-jobs.html) and read by the shared
   Candidate Analysis modal below — this mirrors the original
   single-shared-script design exactly, including its one real
   limitation: if Deep Analysis is opened from rec-actions.html
   (which never populates orgJobs itself), the job-description
   text in that analysis will read "Not provided", same as
   before this rewrite.
========================================================= */
let orgJobs = [];

// Shared by rec-jobs.html and ukjobs.html — both need "the best location
// string for this job" the same way.
function getJobLocation(job) {
  return (
    job.location_display ||
    job.location ||
    (job.city && job.country ? `${job.city}, ${job.country}` : job.country || null)
  );
}

// Shared by ukjobs.html/usajobs.html/uaejobs.html/indiajobs.html —
// fetches a region's job set via the Lambda's `country` branch (see
// api.js's getJobsByCountry) and renders it PROGRESSIVELY.
//
// FIX (perf): this used to enumerate multiple "country code variants"
// per region (e.g. ["GB","UK"], ["US","USA"], ["AE","UAE"],
// ["IN","IND","INDIA"]) on the theory that ingestion had been
// inconsistent about which variant it wrote. Checking the actual
// ingestion Lambda shows that's not the case — every source writes
// exactly ONE real code per region (GB / US / AE / IN); the second/
// third variants never exist in DynamoDB and querying them was pure
// wasted round trips (a full sequential country-index Query loop that
// always came back empty). Dropping them roughly halves — for UAE/
// India, triples — the network calls this function makes.
//
// FIX (perf, main one): getJobsByCountry's own internal pagination
// loop used to be fully awaited before this function returned
// anything, so a heavily-sourced region like GB (Reed + Adzuna
// multi-term + JSearch all landing in one partition) blocked the UI
// for the entire ~10-15-page walk — the 15-18s freeze. This now passes
// an onPage callback straight through so each page can be filtered and
// rendered the moment it arrives, while the walk continues in the
// background. getJobsByCountry also session-caches the assembled
// region list, so a repeat visit in the same tab session skips the
// network and calls onPage once with the complete list immediately.
async function loadJobsForCountryProgressive(countryCode, regionFilterFn, onRegionUpdate) {
  const seen = new Set();
  const regionJobs = [];

  await getJobsByCountry(countryCode, {
    onPage: (pageJobs) => {
      for (const job of pageJobs) {
        if (!job.job_id || seen.has(job.job_id)) continue;
        if (!regionFilterFn(job)) continue;
        seen.add(job.job_id);
        regionJobs.push(job);
      }
      onRegionUpdate(regionJobs);
    }
  });

  return regionJobs;
}


/* =========================================================
   SHARED: LLM CANDIDATE-MATCH ENRICHMENT
   Used by cand-matches.html's loadCandidatesForRole() to add a
   one-line recruiter-facing insight + shortlist flag per
   candidate, in the background after the initial render.
========================================================= */
async function enrichCandidatesWithLLM(candidates, cacheKey, selectedJob) {
  const top15 = candidates.slice(0, 15);
  const slim = top15.map((c, i) => ({
    index: i,
    candidate_id: c.candidate_id,
    name: c.name || c.email || "Candidate",
    match_percent: c.match_percent,
    resume_snippet: (c.resume_text || "").slice(0, 300)
  }));

  const jdSnippet = (selectedJob?.description || selectedJob?.jd || "").slice(0, 500);

  const prompt = `You are a recruiter assistant reviewing candidates for a role.

Job Title: ${selectedJob?.title || "Unknown Role"}
Job Description: ${jdSnippet || "Not provided"}

For each candidate write ONE short sentence (max 16 words) telling the recruiter something specific and useful about why this candidate could be a fit — read their resume_snippet, don't just restate their match_percent.
Rules:
- NEVER use generic phrases like "high match", "great fit", "strong candidate", "relevant experience"
- Flag shortlist_flag=true for at most the top 3 candidates by genuine fit, not just highest match_percent
- Return ONLY a raw JSON array, no markdown:
[{"index":<n>,"candidate_id":"...","recruiter_summary":"<specific sentence>","shortlist_flag":<true|false>}]

Candidates:
${JSON.stringify(slim)}`;

  const fallback = () => candidates.map(c => ({
    candidate_id: c.candidate_id,
    recruiter_summary: null,
    shortlist_flag: false
  }));

  try {
    const raw = await Promise.race([
      callGemini(prompt, "rec_summaries"),
      new Promise(resolve => setTimeout(() => resolve(""), 12000))
    ]);
    if (!raw) return fallback();

    const clean = raw.replace(/```json|```/g, "").trim();
    const jsonStr = clean.match(/\[[\s\S]*\]/)?.[0] || clean;
    const parsed = JSON.parse(jsonStr);

    const byId = {}, byIndex = {};
    parsed.forEach(r => {
      if (r.candidate_id) byId[r.candidate_id] = r;
      if (r.index != null) byIndex[r.index] = r;
    });

    return candidates.map((c, i) => {
      const r = byId[c.candidate_id] || byIndex[i] || {};
      return {
        candidate_id: c.candidate_id,
        recruiter_summary: r.recruiter_summary || null,
        shortlist_flag: !!r.shortlist_flag
      };
    });
  } catch {
    return fallback();
  }
}


/* =========================================================
   SHARED: CANDIDATE ANALYSIS MODAL — RECRUITER SIDE
   Shows resume-vs-JD comparison: strengths, gaps, interview
   questions, and a hire recommendation. Used by both
   cand-matches.html and rec-actions.html card buttons.
========================================================= */
const _recAnalysisCache = {};

window.openCandidateAnalysis = async function (candidateId, candidateName, jobId) {
  if (!$("recAnalysisOverlay")) {
    const overlay = document.createElement("div");
    overlay.id = "recAnalysisOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.78);
      backdrop-filter:blur(6px); z-index:1000;
      display:flex; align-items:center; justify-content:center;
      padding:20px; box-sizing:border-box;
    `;
    overlay.innerHTML = `
      <div id="recAnalysisModal" style="
        background:var(--surface, #0f1220); border:1px solid rgba(122,162,255,0.15);
        border-radius:16px; width:100%; max-width:700px;
        max-height:88vh; overflow-y:auto;
        padding:32px; box-sizing:border-box;
        position:relative; color:var(--text-1, #e2e8f0); font-family:inherit;
      ">
        <button id="recAnalysisClose" style="
          position:absolute; top:16px; right:18px;
          background:none; border:none; color:var(--text-3, #6b7fa8);
          font-size:22px; cursor:pointer; line-height:1;
        ">&#x2715;</button>
        <div id="recAnalysisContent"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.style.display = "none"; });
    $("recAnalysisClose").addEventListener("click", () => { $("recAnalysisOverlay").style.display = "none"; });
  }

  const overlay = $("recAnalysisOverlay");
  const content = $("recAnalysisContent");
  overlay.style.display = "flex";

  content.innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:var(--blue, #7aa2ff);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Analysis</div>
      <h2 style="margin:0;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(candidateName || candidateId)}</h2>
    </div>
    <div style="display:flex;align-items:center;gap:10px;color:var(--text-3, #6b7280);font-size:14px;padding:24px 0;">
      <div style="width:20px;height:20px;border-radius:50%;border:2px solid var(--blue, #7aa2ff);border-top-color:transparent;animation:recSpin 0.8s linear infinite;flex-shrink:0;"></div>
      Comparing resume against job description…
    </div>
    <style>@keyframes recSpin{to{transform:rotate(360deg)}}</style>
  `;

  const cacheKey = `${candidateId}__${jobId}`;
  if (_recAnalysisCache[cacheKey]) {
    renderCandidateAnalysis(content, candidateName, _recAnalysisCache[cacheKey]);
    return;
  }

  let resumeText = "";
  const jobData = orgJobs.find(j => j.job_id === jobId) || {};

  try {
    const snap = await getDoc(doc(db, "candidates", candidateId));
    if (snap.exists()) resumeText = (snap.data().resume_text || "").slice(0, 1200);
  } catch { /* proceed without resume */ }

  const jdText = (jobData.description || jobData.jd || "").slice(0, 1000);

  const prompt = `You are a recruiter assistant reviewing a candidate for a role.

Job Title: ${jobData.title || "Unknown Role"}
Job Description: ${jdText || "Not provided"}

Candidate Resume:
${resumeText || "Not provided"}

Return ONLY a raw JSON object, no markdown, no backticks:
{
  "match_summary": "2-3 sentences: how well this candidate fits the role and why",
  "strengths": ["specific strength from their resume relevant to this JD", "strength 2", "strength 3"],
  "gaps": ["skill or experience missing vs JD", "gap 2"],
  "interview_questions": [
    {"q": "specific question to probe a strength or gap", "why": "what this reveals"},
    {"q": "question 2", "why": "reason"},
    {"q": "question 3", "why": "reason"}
  ],
  "hire_recommendation": "Strong Yes / Yes / Maybe / No — 1 sentence reason"
}`;

  try {
    const raw = await callGemini(prompt, "candidate_analysis");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    _recAnalysisCache[cacheKey] = parsed;
    renderCandidateAnalysis(content, candidateName, parsed, jobData);
  } catch {
    content.innerHTML += `<p style="color:var(--red, #f87171);font-size:13px;margin-top:16px;">Analysis failed. Please try again.</p>`;
  }
};

function renderCandidateAnalysis(content, candidateName, data, jobData = {}) {
  const strengthsHTML = (data.strengths || []).map(s => `
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;">
      <span style="color:var(--green, #4ade80);font-size:14px;flex-shrink:0;">✓</span>
      <span style="color:var(--text-2, #d1d5db);font-size:13px;line-height:1.5;">${escHtml(s)}</span>
    </div>`).join("");

  const gapsHTML = (data.gaps || []).map(g => `
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;">
      <span style="color:var(--amber, #fbbf24);font-size:14px;flex-shrink:0;">△</span>
      <span style="color:var(--text-2, #d1d5db);font-size:13px;line-height:1.5;">${escHtml(g)}</span>
    </div>`).join("");

  const questionsHTML = (data.interview_questions || []).map((q, i) => `
    <div style="padding:12px 14px;background:var(--bg, #0b0e16);border-radius:10px;border:1px solid rgba(122,162,255,0.1);margin-bottom:8px;">
      <div style="font-weight:600;font-size:13px;color:var(--text-1, #e2e8f0);margin-bottom:4px;">Q${i + 1}. ${escHtml(q.q)}</div>
      <div style="font-size:12px;color:var(--text-3, #6b7fa8);font-style:italic;">→ ${escHtml(q.why)}</div>
    </div>`).join("");

  const rec = (data.hire_recommendation || "").toLowerCase();
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const recColor = rec.startsWith("strong yes") ? (light ? "#157a3d" : "#4ade80")
    : rec.startsWith("yes")   ? (light ? "#3a5fd9" : "#7aa2ff")
    : rec.startsWith("maybe") ? (light ? "#b45309" : "#fbbf24")
    : (light ? "#dc2626" : "#f87171");
  const recColorBorder = recColor + "33";

  content.innerHTML = `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:var(--blue, #7aa2ff);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Analysis</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(candidateName)}</h2>
      ${jobData.title ? `<p style="margin:0;color:var(--text-3, #6b7fa8);font-size:13px;">vs. ${escHtml(jobData.title)}</p>` : ""}
    </div>

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:var(--text-3, #6b7280);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Overall Fit</div>
      <p style="color:var(--text-2, #d1d5db);font-size:14px;line-height:1.6;margin:0;">${escHtml(data.match_summary || "")}</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px;">
      <div style="background:var(--bg, #0b0e16);border-radius:10px;padding:14px;border:1px solid rgba(74,222,128,0.12);">
        <div style="font-size:11px;color:var(--green, #4ade80);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">✓ Strengths</div>
        ${strengthsHTML || '<p style="color:var(--text-3, #6b7280);font-size:13px;">None identified</p>'}
      </div>
      <div style="background:var(--bg, #0b0e16);border-radius:10px;padding:14px;border:1px solid rgba(251,191,36,0.12);">
        <div style="font-size:11px;color:var(--amber, #fbbf24);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">△ Gaps</div>
        ${gapsHTML || '<p style="color:var(--text-3, #6b7280);font-size:13px;">None identified</p>'}
      </div>
    </div>

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    ${questionsHTML ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:var(--blue, #7aa2ff);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">💬 Suggested Interview Questions</div>
      ${questionsHTML}
    </div>` : ""}

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg, #0b0e16);border-radius:10px;border:1px solid ${recColorBorder};">
      <div style="font-size:11px;color:var(--text-3, #6b7280);font-weight:700;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Recommendation</div>
      <div style="color:${recColor};font-size:14px;font-weight:600;">${escHtml(data.hire_recommendation || "—")}</div>
    </div>
  `;
}


/* =========================================================
   ====================  REC-DASH.HTML  ====================
   Recruiter Power BI dashboard + DynamoDB self-heal sync.
========================================================= */
if ($("pbi-container") && $("porg")) {
  // SELF-HEAL: fires every time the dashboard loads, keeping the
  // DynamoDB Recruiters table in sync with Firestore without depending
  // on a single fragile call made once at signup. Idempotent (a plain
  // overwrite), fire-and-forget, never blocks the UI or shows an error —
  // any failure is silently retried on the next page load.
  function syncRecruiterToDynamo(uid, email, orgName) {
    if (!uid || !email) return;
    registerRecruiter({ recruiter_id: uid, email, organisation_name: orgName || "Unknown Organisation" })
      .catch(err => logError("recruiter sync failed, will retry next load", err));
  }

  window.boot = async function boot() {
    const btn = $("rbtn");
    btn?.classList.add("spin");
    setProgress(10);
    const eb = $("errBanner");
    if (eb) eb.style.display = "none";

    try {
      if (!window.auth || !window.db || !window.auth.currentUser) {
        console.warn("Auth not ready");
        btn?.classList.remove("spin");
        return;
      }

      const user  = window.auth.currentUser;
      const email = user.email;
      setProgress(25);

      const snap = await getDoc(doc(window.db, "users", user.uid));
      if (!snap.exists()) {
        showErrorBanner("User data not found");
        btn?.classList.remove("spin");
        setProgress(100, { resetStyle: "opacity" });
        return;
      }

      const d    = snap.data();
      const name = d.name || email.split("@")[0] || "Recruiter";
      const org  = d.organisation_name || "Your Organisation";

      $("av").textContent    = (org || name).charAt(0).toUpperCase();
      $("pname").textContent = name;
      $("porg").textContent  = org;
      $("pill").style.display = "flex";
      $("sub").textContent   = `Hiring overview for ${org}`;
      setProgress(50);

      syncRecruiterToDynamo(user.uid, email, d.organisation_name);

      const token = await getEmbedToken();

      if (!token.ok) {
        logError("embed token request failed", { code: `HTTP ${token.status}` });
        showErrorBanner("The analytics dashboard is unavailable right now. Please try again later.");
        btn?.classList.remove("spin");
        setProgress(100, { resetStyle: "opacity" });
        return;
      }
      if (!token.accessToken || !token.embedUrl) {
        logError("embed token response incomplete", { code: "missing-fields" });
        showErrorBanner("The analytics dashboard is unavailable right now. Please try again later.");
        btn?.classList.remove("spin");
        setProgress(100, { resetStyle: "opacity" });
        return;
      }

      setProgress(80);
      embedPowerBI({
        accessToken: token.accessToken,
        embedUrl:    token.embedUrl,
        reportId:    token.reportId,
        onLoaded: () => setProgress(100, { resetStyle: "opacity" })
      });

    } catch (err) {
      logError("recruiter dashboard failed", err);
      showErrorBanner("Could not load this page. Please refresh and try again.");
      setProgress(100, { resetStyle: "opacity" });
    }

    btn?.classList.remove("spin");
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
      if (tries > 50) { clearInterval(t); setProgress(100, { resetStyle: "opacity" }); }
    }, 100);
  })();
}


/* =========================================================
   ====================  REC-JOBS.HTML  ====================
   Recruiter's job list: internal (posted via BeyondMatch) +
   external (job-board API) jobs, scoped to the recruiter's
   own organisation only, with source/location/provider
   filtering.
   NOTE: this page used to also offer an "All Jobs" (platform-
   wide) view via a toggle. That toggle has been removed — this
   page now only ever shows the recruiter's organisation jobs,
   so there's no showAll/allJobs branching left anywhere below.
========================================================= */
if ($("jobsPageTitle") && $("jobsTable")) {
  // Instant skeleton placeholder while data loads
  (function showInstantSkeletons() {
    const grid = $("jobsTable");
    function skel() {
      return `
        <div class="skeleton-candidate-card">
          <div style="display:flex;flex-direction:column;gap:10px;">
            <div class="skeleton-title" style="width:65%;height:16px;margin-bottom:6px;"></div>
            <div class="skeleton-subtitle" style="width:40%;height:12px;"></div>
            <div style="display:flex;gap:6px;">
              <div class="skeleton-chip"></div>
              <div class="skeleton-chip" style="width:80px;"></div>
            </div>
            <div class="skeleton-subtitle" style="width:30%;height:13px;"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
              <div class="skeleton-btn"></div>
              <div class="skeleton-btn"></div>
            </div>
          </div>
        </div>`;
    }
    grid.innerHTML = Array(6).fill(null).map(skel).join("");
  })();

  let recruiterOrg = null;

  async function fetchPostedJobsFromFirestore(recruiterUid) {
    // Jobs posted by this recruiter via rec-postjob.html (source:"beyondmatch")
    try {
      const q = query(collection(db, "posted_jobs"), where("recruiter_id", "==", recruiterUid));
      const snap = await getDocs(q);
      return snap.docs.map(d => {
        const data = d.data();
        return { ...data, job_id: data.job_id || d.id, _firestoreId: d.id, _source: "internal" };
      });
    } catch { return []; }
  }

  async function loadRecruiterJobs() {
    const currentUser = auth.currentUser;

    const [fetchedOrgJobs, firestorePosted] = await Promise.all([
      getJobsByCompany(recruiterOrg),
      currentUser ? fetchPostedJobsFromFirestore(currentUser.uid) : Promise.resolve([])
    ]);

    const taggedOrgJobs = fetchedOrgJobs.map(j => ({ ...j, _source: "external" }));

    // Merge: internal jobs first; skip external if same job_id already internal
    const internalIds = new Set(firestorePosted.map(j => j.job_id));
    orgJobs = [
      ...firestorePosted,
      ...taggedOrgJobs.filter(j => !internalIds.has(j.job_id))
    ];

    renderRecruiterJobs();
    populateLocationFilter();
    populateProviderFilter();

    const intC = orgJobs.filter(j => j._source === "internal").length;
    const extC = orgJobs.filter(j => j._source === "external").length;
    if ($("srcAllCount")) $("srcAllCount").textContent = orgJobs.length;
    if ($("srcIntCount")) $("srcIntCount").textContent = intC;
    if ($("srcExtCount")) $("srcExtCount").textContent = extC;
  }

  // Confirmed from live API responses: field is `source` — "adzuna",
  // "freelancer", "arbeitnow", "remoteok", plus "beyondmatch" for
  // internally-posted jobs (treated as no provider / internal).
  const PROVIDER_DISPLAY_NAMES = {
    adzuna: "Adzuna", freelancer: "Freelancer", arbeitnow: "Arbeitnow", remoteok: "RemoteOK"
  };

  function getJobProvider(job) {
    const raw = job.source;
    if (!raw || typeof raw !== "string") return null;
    const key = raw.trim().toLowerCase();
    if (!key || key === "beyondmatch" || key === "internal") return null;
    return PROVIDER_DISPLAY_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  }

  // Clean pill label: country (+ REMOTE if applicable)
  function formatLocationPill(loc) {
    if (!loc) return "-";
    const isRemote = /\bREMOTE\b/i.test(loc);
    const country  = getRegionLabel(loc); // strips REMOTE internally
    const label    = (country && country.toUpperCase() !== "REMOTE") ? country : null;
    if (isRemote) return label ? `${label}, REMOTE` : "REMOTE";
    return label || loc.split(",")[0].trim() || loc;
  }

  function renderRecruiterJobs() {
    const tableEl = $("jobsTable");
    if (!tableEl) return;

    let filtered = [...orgJobs];

    if (activeSourceFilter) {
      filtered = filtered.filter(j => j._source === activeSourceFilter);
    }
    if (activeProviderFilter) {
      filtered = filtered.filter(j => j._source === "external" && getJobProvider(j) === activeProviderFilter);
    }

    const searchTerm = $("searchInput")?.value.toLowerCase() || "";
    if (searchTerm) {
      filtered = filtered.filter(j => j.title?.toLowerCase().includes(searchTerm));
    }

    if (activeLocationTab) {
      filtered = filtered.filter(j => getRegionLabel(getJobLocation(j)) === activeLocationTab);
    } else {
      const location = $("locationFilter")?.value?.toLowerCase().trim();
      if (location) {
        filtered = filtered.filter(j => (getJobLocation(j) || "").toLowerCase().trim().includes(location));
      }
    }

    const sortValue = $("sortSelect")?.value;
    if (sortValue === "newest") {
      filtered.sort((a, b) => toSortableDate(b.created_at) - toSortableDate(a.created_at));
    } else if (sortValue === "oldest") {
      filtered.sort((a, b) => toSortableDate(a.created_at) - toSortableDate(b.created_at));
    } else if (sortValue === "title") {
      filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    }

    if (!filtered.length) { tableEl.innerHTML = "<p>No jobs found.</p>"; return; }

    tableEl.innerHTML = filtered.map(job => {
      const matchesHref = `cand-matches.html?job=${encodeURIComponent(job.job_id)}`;
      const postJobHref = `rec-postjob.html`;
      const isInternal  = job._source === "internal";

      const jobProvider = !isInternal ? getJobProvider(job) : null;
      const sourceBadge = isInternal
        ? `<span style="
              font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
              padding:3px 8px;border-radius:10px;white-space:nowrap;
              background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.28);color:var(--green, #4ade80);">
             ✦ Internal
           </span>`
        : `<span style="
              font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
              padding:3px 8px;border-radius:10px;white-space:nowrap;
              background:rgba(122,162,255,.10);border:1px solid rgba(122,162,255,.22);color:var(--blue, #7aa2ff);">
             ⬡ External${jobProvider ? ` · ${escHtml(jobProvider)}` : ""}
           </span>`;

      const cardAccent = isInternal ? "border-left:3px solid rgba(74,222,128,.35);" : "";

      const rawDesc  = (job.description || job.jd || "").replace(/<[^>]*>/g, "").trim();
      const descHTML = rawDesc
        ? `<p class="job-modern-desc" style="font-size:12.5px;line-height:1.5;color:var(--text-3, #8a9cc8);margin:2px 0 10px;">
             ${escHtml(rawDesc.slice(0, 130))}${rawDesc.length > 130 ? "…" : ""}
           </p>`
        : "";

      const externalLink = !isInternal ? (safeUrl(job.apply_url) || null) : null;
      const applyBtn = externalLink
        ? `<a class="modern-view-btn"
             href="${escAttr(externalLink)}"
             target="_blank"
             rel="noopener noreferrer"
             style="background:rgba(74,222,128,.10);border-color:rgba(74,222,128,.28);color:var(--green, #4ade80);">
            View Job ↗
          </a>`
        : "";

      return `
      <div class="job-modern-card" style="${cardAccent}">
        <div class="job-modern-header">
          <h3>${escHtml(job.title)}</h3>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          ${sourceBadge}
          <span class="job-pill">${escHtml(formatLocationPill(getJobLocation(job)))}</span>
        </div>
        <div class="job-modern-company">${escHtml(job.company || "-")}</div>
        <div class="job-modern-salary">${escHtml(formatSalary(job))}</div>
        ${descHTML}
        <div class="job-modern-actions">
          <a class="modern-view-btn" href="${escAttr(matchesHref)}" data-job-id="${escAttr(job.job_id)}">
            View Matches →
          </a>
          <a class="modern-view-btn" href="${postJobHref}"
             style="background:rgba(192,132,252,.10);border-color:rgba(192,132,252,.25);color:var(--purple, #c084fc);">
            + Post Similar
          </a>
          ${applyBtn}
        </div>
      </div>`;
    }).join("");
  }


  let activeLocationTab = "";
  let activeSourceFilter = "";
  let activeProviderFilter = "";

  function populateLocationFilter() {
    const select  = $("locationFilter");
    const tabsRow = $("locationTabsRow");

    const sourceJobs = orgJobs;
    const locations  = [...new Set(sourceJobs.map(getJobLocation).filter(Boolean))];

    if (select) {
      select.innerHTML = `
        <option value="">All Locations</option>
        ${locations.map(loc => `<option value="${escAttr(loc)}">${escHtml(loc)}</option>`).join("")}
      `;
      select.style.display = "none";
    }

    if (!tabsRow) return;

    const regionMap = {};
    sourceJobs.forEach(j => {
      const loc = getJobLocation(j);
      const region = getRegionLabel(loc);
      if (!region) return;
      if (!regionMap[region]) regionMap[region] = new Set();
      regionMap[region].add(loc);
    });

    const regionCount = {};
    sourceJobs.forEach(j => {
      const loc = getJobLocation(j);
      const region = getRegionLabel(loc);
      if (!region) return;
      regionCount[region] = (regionCount[region] || 0) + 1;
    });

    const regions = Object.keys(regionMap).sort((a, b) => (regionCount[b] || 0) - (regionCount[a] || 0));
    const totalCount = sourceJobs.length;

    function buildTabHTML(r) {
      const count = regionCount[r] || 0;
      return `<button class="loc-tab${activeLocationTab === r ? " active" : ""}" data-loc="${escAttr(r)}">
        ${escHtml(r)}<span class="loc-count">${count}</span>
      </button>`;
    }

    const allTabHTML = `<button class="loc-tab${activeLocationTab === "" ? " active" : ""}" data-loc="">
      All<span class="loc-count">${totalCount}</span>
    </button>`;

    tabsRow.innerHTML = allTabHTML + regions.map(buildTabHTML).join("");

    tabsRow.querySelectorAll(".loc-tab[data-loc]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeLocationTab = btn.dataset.loc;
        tabsRow.querySelectorAll(".loc-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        if (select) select.value = "";
        renderRecruiterJobs();
      });
    });
  }

  function populateProviderFilter() {
    const wrap = $("providerTabsWrap");
    const tabsRow = $("providerTabsRow");
    if (!wrap || !tabsRow) return;

    const sourceJobs = orgJobs.filter(j => j._source === "external");

    const providerCount = {};
    sourceJobs.forEach(j => {
      const p = getJobProvider(j);
      if (!p) return;
      providerCount[p] = (providerCount[p] || 0) + 1;
    });

    const providers = Object.keys(providerCount).sort((a, b) => providerCount[b] - providerCount[a]);

    if (!providers.length) {
      wrap.style.display = "none";
      activeProviderFilter = "";
      return;
    }

    wrap.style.display = "flex";
    const totalExternal = sourceJobs.length;

    function buildTabHTML(p) {
      return `<button class="provider-tab${activeProviderFilter === p ? " active" : ""}" data-provider="${escAttr(p)}">
        ${escHtml(p)}<span class="provider-count">${providerCount[p]}</span>
      </button>`;
    }

    const allTabHTML = `<button class="provider-tab${activeProviderFilter === "" ? " active" : ""}" data-provider="">
      All<span class="provider-count">${totalExternal}</span>
    </button>`;

    tabsRow.innerHTML = allTabHTML + providers.map(buildTabHTML).join("");

    tabsRow.querySelectorAll(".provider-tab[data-provider]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeProviderFilter = btn.dataset.provider;
        tabsRow.querySelectorAll(".provider-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderRecruiterJobs();
      });
    });
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) { $("jobsPageTitle").textContent = "Not authenticated"; return; }

    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { $("jobsPageTitle").textContent = "Recruiter record not found"; return; }

    recruiterOrg = snap.data().organisation_name;
    if (!recruiterOrg) { $("jobsPageTitle").textContent = "No organisation linked"; return; }

    $("jobsPageTitle").textContent = `${recruiterOrg} Jobs`;
    await loadRecruiterJobs();
  });

  ["srcAllBtn", "srcIntBtn", "srcExtBtn"].forEach(btnId => {
    $(btnId)?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      activeSourceFilter = btn.dataset.src || "";
      activeLocationTab = "";
      activeProviderFilter = "";
      document.querySelectorAll(".src-tab").forEach(b => {
        b.classList.remove("active-all", "active-int", "active-ext");
      });
      const cls = activeSourceFilter === "internal" ? "active-int"
        : activeSourceFilter === "external" ? "active-ext" : "active-all";
      btn.classList.add(cls);
      populateLocationFilter();
      populateProviderFilter();
      renderRecruiterJobs();
    });
  });

  $("locationFilter")?.addEventListener("change", renderRecruiterJobs);
  $("searchInput")?.addEventListener("input", renderRecruiterJobs);
  $("sortSelect")?.addEventListener("change", renderRecruiterJobs);
}


/* =========================================================
   ==================  REC-POSTJOB.HTML  ===================
   Two modes: "Upload JD" (extract raw text from a file, then
   AI auto-fills the manual form below) and "Manual" entry
   directly. Submission always reads from the manual form
   fields, whichever mode filled them.
========================================================= */
if ($("dz") && $("subBtn")) {
  function cc(el, id) { $(id).textContent = el.value.length; }

  /* ── mode switch ── */
  function mode(m) {
    const up = m === "upload";
    $("upPanel").style.display = up ? "flex" : "none";
    $("manPanel").style.display = up ? "none" : "flex";
    $("tMan").classList.toggle("on", !up);
    $("tUp").classList.toggle("on", up);
    $("sub").textContent = up
      ? "Upload a PDF or DOCX — AI will fill the form for you"
      : "Fill in the details below or switch to Upload JD";
    $("panel").scrollTop = 0;
  }
  window.mode = mode;

  /* ── employment-type pills ── */
  document.querySelectorAll(".tp").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tp").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
    });
  });
  const getPill = () => { const s = document.querySelector(".tp.on"); return s ? s.dataset.v : "Full-time"; };

  /* ── currency selector: updates the $ symbol + code shown next to
     Salary Min/Max so they always reflect the chosen currency ── */
  function applyCurrencyDisplay() {
    const opt = $("f_cur")?.selectedOptions?.[0];
    if (!opt) return;
    document.querySelectorAll(".cur-sym").forEach(el => el.textContent = opt.dataset.sym || "$");
    document.querySelectorAll(".cur-code").forEach(el => el.textContent = opt.value);
  }
  $("f_cur")?.addEventListener("change", applyCurrencyDisplay);
  applyCurrencyDisplay();

  /* ── skill tags ── */
  const skArr = [];
  function addSk(raw) {
    const s = raw.trim().replace(/,/g, ""); if (!s) return;
    const k = s.toLowerCase(); if (skArr.includes(k)) return;
    skArr.push(k);
    const t = document.createElement("div");
    t.className = "skt"; t.dataset.k = k;
    t.innerHTML = `${escHtml(s)}<button type="button">×</button>`;
    t.querySelector("button").onclick = () => { skArr.splice(skArr.indexOf(k), 1); t.remove(); };
    $("skw").insertBefore(t, $("skIn"));
  }
  $("skIn").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addSk($("skIn").value); $("skIn").value = ""; }
    if (e.key === "Backspace" && !$("skIn").value) {
      const ts = document.querySelectorAll(".skt"); if (ts.length) ts[ts.length - 1].querySelector("button").click();
    }
  });
  $("skIn").addEventListener("blur", () => { if ($("skIn").value.trim()) { addSk($("skIn").value); $("skIn").value = ""; } $("skw").classList.remove("focused"); });
  $("skIn").addEventListener("focus", () => $("skw").classList.add("focused"));

  /* ── file upload ── */
  function clearFile() {
    $("fileInput").value = ""; $("fchosen").classList.remove("show");
    $("pprog").classList.remove("show"); $("jdx").classList.remove("show");
  }
  window.clearFile = clearFile;

  $("fileInput").addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  const dzEl = $("dz");
  dzEl.addEventListener("dragover", e => { e.preventDefault(); dzEl.classList.add("drag"); });
  dzEl.addEventListener("dragleave", () => dzEl.classList.remove("drag"));
  dzEl.addEventListener("drop", e => {
    e.preventDefault(); dzEl.classList.remove("drag");
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });

  async function handleFile(file) {
    if (!/\.(pdf|docx?|txt)$/i.test(file.name)) { showErrorBanner("Upload PDF, DOCX, or TXT."); return; }
    $("errBanner").style.display = "none";
    $("fname").textContent = file.name;
    $("fchosen").classList.add("show");
    $("pprog").classList.add("show");
    $("jdx").classList.remove("show");
    try {
      let txt = "";
      if (/\.txt$/i.test(file.name)) txt = await file.text();
      else txt = await parseDocumentWithLayout(file); // pdf/docx — preserves line breaks for JD parsing
      $("jdText").value = txt.trim();
      $("pprog").classList.remove("show");
      $("jdx").classList.add("show");
    } catch (err) {
      $("pprog").classList.remove("show");
      logError("job description file read failed", err);
      showErrorBanner("Could not read that file. Please try another file.");
    }
  }

  /* ── AI auto-fill ──
     Gemini sometimes truncates its output on a long JD, leaving broken
     JSON. The repair strategy below: strip markdown fences, find the
     JSON object start, and if it doesn't end with '}', close it at the
     last safely-terminated value. If parsing still fails, fall back to
     regex field extraction so at least title/location/skills fill in. */
  window.aiParse = async function aiParse() {
    const txt = $("jdText").value.trim();
    if (!txt) { showErrorBanner("No extracted text."); return; }
    const btn = $("aibtn"); btn.disabled = true;
    btn.innerHTML = `<div class="bspin" style="display:block;width:11px;height:11px;border-width:2px;"></div> Parsing…`;
    $("errBanner").style.display = "none";
    setProgress(20, { resetStyle: "opacity" });

    try {
      const raw = await callGemini(`You are a job description parser. Extract structured data from the JD text below.

IMPORTANT RULES:
- salary_min and salary_max must be plain integers with NO commas, symbols, or letters (e.g. 400000 not ₹4,00,000)
- If salary uses Indian lakh format like "4,00,000" convert it: remove commas → 400000
- remote must be exactly one of: "onsite" | "remote" | "hybrid" — infer from work mode, location, or keywords like Hybrid/Remote/WFH
- experience must be exactly one of: "0-1" | "1-3" | "3-5" | "5-8" | "8+" | "" — map ranges like "1–3 years" → "1-3"
- level must be exactly one of: "Junior" | "Mid" | "Senior" | "Lead" | "Manager" | "Director" | "VP" | ""
- employment_type must be exactly one of: "Full-time" | "Part-time" | "Contract" | "Internship" | "Freelance"
- industry must be exactly one of: "Technology" | "Finance" | "Healthcare" | "E-commerce" | "Education" | "Manufacturing" | "Media & Entertainment" | "Consulting" | "Government" | "Non-profit" | "Other"
- function must be exactly one of: "Engineering" | "Data Science / Analytics" | "Design / UX" | "Product Management" | "Marketing" | "Sales" | "Operations" | "HR / Talent" | "Finance / Accounting" | "Legal" | "Customer Success" | "Other"
- deadline must be in YYYY-MM-DD format if found, else ""
- openings must be a plain integer, default 1
- skills must be an array of short skill strings (no duplicates, max 15)
- description should be the full role overview + responsibilities + requirements as a clean paragraph, no bullet symbols
- location should be city + country only, no work mode suffix
- apply_url only if an explicit URL is present in the text, else ""

Return ONLY a raw JSON object, no markdown, no backticks, no explanation:
{"title":"","location":"","remote":"onsite","employment_type":"Full-time","salary_min":0,"salary_max":0,"experience":"","level":"","skills":[],"description":"","industry":"","function":"","deadline":"","openings":1,"apply_url":""}

JD:
${txt.slice(0, 12000)}`, "jd_parse");

      if (!raw || !raw.trim()) {
        throw new Error("The AI service is temporarily unavailable (503). Please try again in a moment.");
      }

      let clean = raw.replace(/```json[\s\S]*?```|```/g, "").trim();

      const objStart = clean.indexOf("{");
      if (objStart > 0) clean = clean.slice(objStart);

      if (!clean.trimEnd().endsWith("}")) {
        const lastSafe = Math.max(
          clean.lastIndexOf('"'),
          clean.lastIndexOf("]"),
          clean.lastIndexOf("true"),
          clean.lastIndexOf("false"),
          clean.lastIndexOf("null"),
          (() => { const m = clean.match(/\d(?=[^\d]*$)/); return m ? m.index : -1; })()
        );
        if (lastSafe > 0) {
          clean = clean.slice(0, lastSafe + 1).replace(/,\s*$/, "").replace(/,\s*"[^"]*$/, "");
          const opens = (clean.match(/\[/g) || []).length;
          const closes = (clean.match(/\]/g) || []).length;
          if (opens > closes) clean += "]";
          clean += "}";
        }
      }

      let d;
      try {
        d = JSON.parse(clean);
      } catch (jsonErr) {
        logError("job description parse: JSON repair failed, using fallback", jsonErr);
        const grab = (key, fallback = "") => {
          const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
          return m ? m[1] : fallback;
        };
        const grabNum = (key) => {
          const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
          return m ? parseInt(m[1]) : 0;
        };
        const grabArr = (key) => {
          const m = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)`));
          if (!m) return [];
          return m[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || [];
        };
        d = {
          title: grab("title"), location: grab("location"), remote: grab("remote", "onsite"),
          employment_type: grab("employment_type", "Full-time"),
          salary_min: grabNum("salary_min"), salary_max: grabNum("salary_max"),
          experience: grab("experience"), level: grab("level"), skills: grabArr("skills"),
          description: grab("description"), industry: grab("industry"), function: grab("function"),
          deadline: grab("deadline"), openings: grabNum("openings") || 1, apply_url: grab("apply_url")
        };
        showToast("AI response was truncated — some fields may be missing. Review before posting.", "warning", "Partial Auto-fill");
      }

      if (d.title) { $("f_title").value = d.title; cc($("f_title"), "tc"); }

      if (d.location) $("f_loc").value = d.location.replace(/[,\s]*(hybrid|remote|onsite|wfh)$/i, "").trim();

      const remMap = { onsite: "onsite", remote: "remote", hybrid: "hybrid" };
      if (d.remote && remMap[d.remote.toLowerCase()]) $("f_rem").value = remMap[d.remote.toLowerCase()];

      if (d.employment_type) {
        document.querySelectorAll(".tp").forEach(b => b.classList.toggle("on", b.dataset.v === d.employment_type));
      }

      const cleanInt = v => parseInt(String(v).replace(/[^\d]/g, "")) || 0;
      const sMin = cleanInt(d.salary_min); const sMax = cleanInt(d.salary_max);
      if (sMin > 0) $("f_smin").value = sMin;
      if (sMax > 0) $("f_smax").value = sMax;

      if (d.experience) {
        const expNorm = String(d.experience).replace(/[–—]/g, "-").trim();
        const validExp = ["0-1", "1-3", "3-5", "5-8", "8+"];
        $("f_exp").value = validExp.includes(expNorm) ? expNorm : "";
      }

      if (d.level) {
        const validLvl = ["Junior", "Mid", "Senior", "Lead", "Manager", "Director", "VP"];
        $("f_lvl").value = validLvl.includes(d.level) ? d.level : "";
      }

      $("f_desc").value = txt;
cc($("f_desc"), "dc");

      if (d.industry) {
        const indOpts = [...document.querySelectorAll("#f_ind option")].map(o => o.value);
        const best = indOpts.find(o => o && d.industry.toLowerCase().includes(o.toLowerCase()))
          || indOpts.find(o => o && o.toLowerCase().includes(d.industry.toLowerCase().split(/[\s/]/)[0]));
        if (best) $("f_ind").value = best;
      }

      if (d.function) {
        const funOpts = [...document.querySelectorAll("#f_fun option")].map(o => o.value);
        const funLow = d.function.toLowerCase();
        const best = funOpts.find(o => o && funLow.includes(o.toLowerCase().split(/[\s/]/)[0]))
          || funOpts.find(o => o && o.toLowerCase().includes(funLow.split(/[\s/]/)[0]));
        if (best) $("f_fun").value = best;
      }

      if (d.deadline && /^\d{4}-\d{2}-\d{2}$/.test(d.deadline)) $("f_dl").value = d.deadline;
      if (d.openings && parseInt(d.openings) > 0) $("f_op").value = parseInt(d.openings);
      if (d.apply_url) $("f_apply").value = d.apply_url;

      if (Array.isArray(d.skills) && d.skills.length) {
        skArr.length = 0; document.querySelectorAll(".skt").forEach(t => t.remove());
        d.skills.slice(0, 15).forEach(s => addSk(s));
      }

      setProgress(100, { resetStyle: "opacity" });
      showToast("Form auto-filled ✓", "success");
      mode("manual");
    } catch (err) {
      setProgress(100, { resetStyle: "opacity" });
      showErrorBanner("The AI could not read that job description. Please try again or fill the form manually.");
      logError("job description AI parse failed", err);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Auto-fill form with AI`;
    }
  };

  /* ── reset ── */
  window.resetForm = function resetForm() {
    ["f_title", "f_loc", "f_smin", "f_smax", "f_desc", "f_dl", "f_apply"].forEach(id => $(id).value = "");
    $("f_rem").value = "onsite"; $("f_exp").value = ""; $("f_lvl").value = "";
    $("f_ind").value = ""; $("f_fun").value = ""; $("f_op").value = "1";
    if ($("f_cur")) { $("f_cur").value = "USD"; applyCurrencyDisplay(); }
    document.querySelectorAll(".tp").forEach((b, i) => b.classList.toggle("on", i === 0));
    skArr.length = 0; document.querySelectorAll(".skt").forEach(t => t.remove());
    $("tc").textContent = "0"; $("dc").textContent = "0";
    $("errBanner").style.display = "none"; $("okBanner").style.display = "none";
  };

  /* ── submit ──
     Builds a real internal apply URL (cand_actions.html?apply=...) for
     BeyondMatch-posted jobs unless the recruiter entered an external
     URL manually — this is a genuinely different apply-link pattern
     from jobmatches.html's, preserved exactly as the original built it. */
  window.submitJob = async function submitJob() {
    $("errBanner").style.display = "none"; $("okBanner").style.display = "none";

    const inUploadMode = $("tUp").classList.contains("on");
    const hasExtractedText = $("jdText") && $("jdText").value.trim().length > 0;
    const formIsEmpty = !$("f_title").value.trim() && !$("f_desc").value.trim();
    if (inUploadMode && formIsEmpty) {
      if (hasExtractedText) {
        showErrorBanner('Click "Auto-fill form with AI" first, then review and post.');
      } else {
        showErrorBanner("Please upload a JD file first, then use Auto-fill before posting.");
      }
      $("errBanner").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    const title = $("f_title").value.trim();
    const loc = $("f_loc").value.trim();
    const desc = $("f_desc").value.trim();
    if (!title) { showErrorBanner("Job title is required."); return; }
    if (!loc) { showErrorBanner("Location is required."); return; }
    if (!desc) { showErrorBanner("Job description is required."); return; }
    if (!auth.currentUser) { showErrorBanner("Not authenticated — please refresh."); return; }

    const manualUrl = $("f_apply").value.trim();
    // FIX: job_id used to be `bm_${uid}_${Date.now()}` — millisecond
    // timestamp only. Two rapid clicks, or a request that gets retried
    // at the network/browser level, could send the identical job_id
    // twice, which the backend's ConditionExpression correctly (and
    // intentionally) rejects with a 409 "Job already exists". Adding a
    // random suffix makes an accidental collision astronomically
    // unlikely without touching the backend's dedupe guard at all.
    const jobIdTemp = `bm_${auth.currentUser.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const internalApplyUrl = `${window.location.origin}/cand_actions.html?apply=${encodeURIComponent(jobIdTemp)}&title=${encodeURIComponent(title)}&recruiter=${encodeURIComponent(auth.currentUser.uid)}`;
    const applyUrl = manualUrl || internalApplyUrl;
    const sMin = parseInt($("f_smin").value) || 0;
    const sMax = parseInt($("f_smax").value) || 0;
    if (sMin && sMax && sMin > sMax) { showErrorBanner("Salary min cannot exceed salary max."); return; }

    const btn = $("subBtn"); btn.classList.add("ld"); btn.disabled = true;
    setProgress(15, { resetStyle: "opacity" });
    try {
      const user = auth.currentUser;
      const snap = await getDoc(doc(db, "users", user.uid));
      const ud = snap.exists() ? snap.data() : {};
      setProgress(60, { resetStyle: "opacity" });

      const payload = {
        job_id: jobIdTemp,
        title, location: loc, location_display: loc,
        remote: $("f_rem").value,
        employment_type: getPill(),
        currency: $("f_cur")?.value || "USD",
        salary_min: sMin, salary_max: sMax, salary_min_usd: sMin, salary_max_usd: sMax,
        experience: $("f_exp").value,
        level: $("f_lvl").value,
        skills: [...skArr], description: desc, jd: desc,
        industry: $("f_ind").value, job_function: $("f_fun").value,
        openings: parseInt($("f_op").value) || 1,
        deadline: $("f_dl").value || null,
        apply_url: applyUrl,
        application_url: applyUrl,
        source: "beyondmatch", posted_by: "recruiter",
        recruiter_id: user.uid, recruiter_email: user.email,
        company: ud.organisation_name || "Your Company",
        is_active: true, posted_at: new Date().toISOString()
      };

      const result = await postJob(payload);
      setProgress(85, { resetStyle: "opacity" });

      try {
  // SEC-13: the Firestore mirror does not need the recruiter's email address
  // (nothing reads it, and every signed-in user can read posted jobs), so it
  // is left out of the mirror. The backend copy is unchanged.
  const { recruiter_email: _omitted, ...mirror } = payload;
  await addDoc(collection(db, "posted_jobs"), {
    ...mirror,

    // Use the backend/DeepL version for the fields displayed
    // throughout the recruiter UI.
    title: result.title || payload.title,
    description: result.description || payload.description,
    jd: result.description || payload.jd,

    // Preserve the original recruiter-submitted content.
    original_title: result.original_title || payload.title,
    original_description: result.original_description || payload.description,

    // Translation metadata.
    translated: result.translated === true,
    source_language: result.source_language || null,
    translation_provider: result.translation_provider || null,

    apply_url: applyUrl,
    application_url: applyUrl,
    created_at: serverTimestamp()
  });
} catch {
  /* backend post already succeeded — Firestore mirror is best-effort */
}
      setProgress(100, { resetStyle: "opacity" });

      const ob = $("okBanner"); ob.style.display = "flex"; ob.scrollIntoView({ behavior: "smooth", block: "nearest" });
      showToast("Job posted successfully!", "success");
      window.resetForm();
    } catch (err) {
      setProgress(100, { resetStyle: "opacity" });

      // FIX: a 409 here means this exact job_id was already written.
      // With the random suffix above this should be effectively
      // impossible from normal use, but if it still happens (e.g. a
      // verbatim request replay), treat it as "already saved" instead
      // of blocking the recruiter on a resubmit — the data from the
      // first successful attempt is already in the database.
      if (String(err.message || "").toLowerCase().includes("already exists")) {
        showToast("That submission was already received.", "warning");
        const ob = $("okBanner"); ob.style.display = "flex"; ob.scrollIntoView({ behavior: "smooth", block: "nearest" });
        window.resetForm();
      } else {
        logError("job post failed", err);
        showErrorBanner("Failed to post the job. Please try again.");
        showToast("Post failed", "error");
      }
    } finally {
      btn.classList.remove("ld"); btn.disabled = false;
    }
  };

  /* ── auth init ── */
  (function () {
    let n = 0, t = setInterval(() => {
      n++;
      if (window.auth !== undefined && window.db !== undefined) {
        clearInterval(t);
        if (typeof window.auth.onAuthStateChanged === "function") {
          window.auth.onAuthStateChanged(u => { if (!u) window.location.href = "/index.html"; else setProgress(100, { resetStyle: "opacity" }); });
        } else setProgress(100, { resetStyle: "opacity" });
      }
      if (n > 50) { clearInterval(t); setProgress(100, { resetStyle: "opacity" }); }
    }, 100);
  })();
}


/* =========================================================
   ==================  REC-ACTIONS.HTML  ===================
   Recruiter's view of applications to their jobs: status
   pipeline, private notes, candidate profile, and
   notifications.
========================================================= */
if ($("actionsContainer")) {
  // Skeleton placeholder while applications load
  (function () {
    const grid = $("actionsContainer");
    function skel() {
      return `
        <div class="skeleton-candidate-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
            <div class="skeleton-title" style="width:55%;height:16px;"></div>
            <div class="skeleton-chip" style="width:70px;height:20px;border-radius:6px;"></div>
          </div>
          <div class="skeleton-subtitle" style="width:80%;height:12px;margin-bottom:6px;"></div>
          <div class="skeleton-subtitle" style="width:60%;height:12px;margin-bottom:16px;"></div>
          <div style="display:flex;gap:8px;">
            <div class="skeleton-btn" style="width:90px;"></div>
            <div class="skeleton-btn" style="width:80px;"></div>
            <div class="skeleton-btn" style="width:70px;"></div>
          </div>
        </div>`;
    }
    grid.innerHTML = Array(6).fill(null).map(skel).join("");
  })();

  let allApplications = [];
  let activeStatus = "all";
  let searchQuery = "";
  let currentNoteAppId = null;
  let unsub = null;
  let _renderGen = 0; // increments each snapshot; stale async runs are discarded

  const STATUSES = ["applied", "reviewing", "shortlisted", "interview", "hired", "rejected"];
  const STATUS_LABELS = {
    applied: "Applied", reviewing: "Reviewing", shortlisted: "Shortlisted",
    interview: "Interview", hired: "Hired", rejected: "Rejected"
  };

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    await loadApplications(user.uid);
    subscribeNotifications(user.uid);
  });

  function loadApplications(recruiterId) {
    // No orderBy — sorting happens in JS so only a single-field index
    // (on recruiter_id) is needed, not a composite one.
    const q = query(collection(db, "applications"), where("recruiter_id", "==", recruiterId));

    if (unsub) unsub();
    unsub = onSnapshot(q, async (snap) => {
      const myGen = ++_renderGen;

      const container = $("actionsContainer");
      if (container) {
        const skelCount = Math.min(Math.max(snap.docs.length, 1), 6);
        function skel() {
          return `
            <div class="skeleton-candidate-card">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
                <div class="skeleton-title" style="width:55%;height:16px;"></div>
                <div class="skeleton-chip" style="width:70px;height:20px;border-radius:6px;"></div>
              </div>
              <div class="skeleton-subtitle" style="width:80%;height:12px;margin-bottom:6px;"></div>
              <div class="skeleton-subtitle" style="width:60%;height:12px;margin-bottom:16px;"></div>
              <div style="display:flex;gap:8px;">
                <div class="skeleton-btn" style="width:90px;"></div>
                <div class="skeleton-btn" style="width:80px;"></div>
                <div class="skeleton-btn" style="width:70px;"></div>
              </div>
            </div>`;
        }
        container.innerHTML = Array(skelCount).fill(null).map(skel).join("");
      }

      const apps = [];
      const jobCache = {};
      const candCache = {};

      for (const docSnap of snap.docs) {
        const d = docSnap.data();
        const appId = docSnap.id;

        if (!jobCache[d.job_id]) {
          try {
            const jSnap = await getDoc(doc(db, "posted_jobs", d.job_id));
            jobCache[d.job_id] = jSnap.exists() ? jSnap.data() : { title: d.job_title || "Unknown Job" };
          } catch { jobCache[d.job_id] = { title: d.job_title || "Unknown Job" }; }
        }
        if (!candCache[d.candidate_id]) {
          try {
            const cSnap = await getDoc(doc(db, "candidates", d.candidate_id));
            candCache[d.candidate_id] = cSnap.exists() ? cSnap.data() : {};
          } catch { candCache[d.candidate_id] = {}; }
        }

        apps.push({
          id: appId, ...d,
          jobTitle: jobCache[d.job_id]?.title || d.job_title || "Unknown Job",
          candidateName: candCache[d.candidate_id]?.name || d.candidate_name || "Unknown",
          candidateRole: candCache[d.candidate_id]?.applied_role || "",
          candidateEmail: candCache[d.candidate_id]?.email || d.candidate_email || "",
          resumeText: candCache[d.candidate_id]?.resume_text || "",
          candidateUserUid: d.candidate_user_id || null
        });
      }

      apps.sort((a, b) => {
        const ta = a.applied_at?.toMillis ? a.applied_at.toMillis() : 0;
        const tb = b.applied_at?.toMillis ? b.applied_at.toMillis() : 0;
        return tb - ta;
      });

      if (myGen !== _renderGen) return; // a newer snapshot fired while we awaited — discard

      allApplications = apps;
      updateCounts();
      renderCards();
    });
  }

  function updateCounts() {
    $("cnt-all").textContent = allApplications.length;
    STATUSES.forEach(s => {
      const el = $(`cnt-${s}`);
      if (el) el.textContent = allApplications.filter(a => a.status === s).length;
    });
  }

  function renderCards() {
    const container = $("actionsContainer");
    let apps = allApplications;

    if (activeStatus !== "all") apps = apps.filter(a => a.status === activeStatus);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      apps = apps.filter(a =>
        a.candidateName.toLowerCase().includes(q) ||
        a.jobTitle.toLowerCase().includes(q) ||
        (a.candidateRole || "").toLowerCase().includes(q)
      );
    }

    if (!apps.length) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <h3>No applications ${activeStatus !== "all" ? `in "${escHtml(STATUS_LABELS[activeStatus])}"` : ""}</h3>
          <p>${activeStatus === "all" ? "Applications from candidates will appear here when they apply to your jobs." : "No candidates at this stage yet."}</p>
        </div>`;
      return;
    }

    container.innerHTML = apps.map(app => buildCard(app)).join("");
  }

  function buildCard(app) {
    const status = app.status || "applied";
    const chipClass = `chip-${escAttr(status)}`;
    const timeAgo = app.applied_at?.toDate ? timeSince(app.applied_at.toDate()) : "Recently";
    const coverPreview = app.note
      ? `<div class="app-note-preview" style="border-left-color:rgba(122,162,255,.2);color:var(--text-3, #6b7fa8);">
          💬 ${escHtml(app.note.length > 90 ? app.note.slice(0, 90) + "…" : app.note)}
         </div>`
      : "";
    const recNotePreview = app.rec_note
      ? `<div class="app-note-preview" style="border-left-color:rgba(192,132,252,.35);color:var(--purple, #c084fc);font-style:normal;">
          📝 ${escHtml(app.rec_note.length > 90 ? app.rec_note.slice(0, 90) + "…" : app.rec_note)}
         </div>`
      : "";
    const unreadClass = app.rec_unread ? "unread" : "";

    return `
      <div class="app-card ${unreadClass}" data-id="${escAttr(app.id)}"
           data-cand-name="${escAttr(app.candidateName)}" data-rec-note="${escAttr(app.rec_note || "")}"
           data-note="${escAttr(app.note || "")}" data-candidate-id="${escAttr(app.candidate_id)}"
           data-job-id="${escAttr(app.job_id)}" data-cand-uid="${escAttr(app.candidateUserUid)}"
           data-job-title="${escAttr(app.jobTitle)}">
        <div class="app-card-top">
          <div>
            <div class="app-cand-name">${escHtml(app.candidateName)}</div>
            <div class="app-cand-role">${escHtml(app.candidateRole || "Candidate")}</div>
          </div>
          <span class="app-status-chip ${chipClass}">${escHtml(STATUS_LABELS[status])}</span>
        </div>

        <div class="app-job-row">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
          <span class="app-job-name">${escHtml(app.jobTitle)}</span>
        </div>

        <div class="app-meta">
          <span>📅 Applied ${escHtml(timeAgo)}</span>
          ${app.candidateEmail ? `<span>✉ ${escHtml(app.candidateEmail)}</span>` : ""}
        </div>

        ${coverPreview}
        ${recNotePreview}

       <div class="app-actions">
          <button class="app-btn" onclick="openProfile(this.closest('.app-card').dataset.id)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            Profile
          </button>
          <button class="app-btn" onclick="const d=this.closest('.app-card').dataset;openNoteModal(d.id,d.candName,d.recNote,d.note)">
            📝 Note${app.rec_note ? " ✎" : ""}
          </button>
          <button class="app-btn" onclick="const d=this.closest('.app-card').dataset;openCandidateAnalysis(d.candidateId,d.candName,d.jobId)">
            🔍 Analyse
          </button>
          <select class="app-btn" style="cursor:pointer;padding:6px 10px;"
            onchange="const d=this.closest('.app-card').dataset;setStatus(d.id,this.value,d.candUid,d.candName,d.jobTitle);this.value='';">
            <option value="" disabled selected>⟳ Update status…</option>
            <option value="reviewing"   ${status === "reviewing" ? "disabled" : ""}>Reviewing</option>
            <option value="shortlisted" ${status === "shortlisted" ? "disabled" : ""}>Shortlisted</option>
            <option value="interview"   ${status === "interview" ? "disabled" : ""}>Interview</option>
            <option value="hired"       ${status === "hired" ? "disabled" : ""}>✓ Hire</option>
            <option value="rejected"    ${status === "rejected" ? "disabled" : ""}>✗ Reject</option>
          </select>
        </div>
      </div>`;
  }

  window.setStatus = async function (appId, newStatus, candidateUserUid, candidateName, jobTitle) {
    try {
      await updateDoc(doc(db, "applications", appId), {
        status: newStatus,
        updated_at: serverTimestamp(),
        cand_unread: true
      });

      await addDoc(collection(db, "notifications"), {
        to_user_id: candidateUserUid,
        to_role: "candidate",
        from_role: "recruiter",
        from_user_id: auth.currentUser.uid, // SEC-11: rules require the signed-in uid
        type: "status_update",
        app_id: appId,
        job_title: jobTitle,
        new_status: newStatus,
        message: `Your application for "${jobTitle}" has been moved to ${STATUS_LABELS[newStatus]}.`,
        read: false,
        created_at: serverTimestamp()
      });

      showToast(`Status updated to ${STATUS_LABELS[newStatus]}`, "success");
    } catch (err) {
      showToast("Failed to update status", "error");
      logError("status update failed", err);
    }
  };

  window.openNoteModal = function (appId, candName, recNote, coverNote) {
    currentNoteAppId = appId;
    $("noteModalName").textContent = decodeAttr(candName);
    $("noteTextarea").value = decodeAttr(recNote || "");
    const coverSection = $("coverNoteSection");
    const coverText = $("coverNoteText");
    const decoded = decodeAttr(coverNote || "");
    if (decoded) {
      coverText.textContent = decoded;
      coverSection.style.display = "block";
    } else {
      coverSection.style.display = "none";
    }
    $("noteOverlay").style.display = "flex";
  };
  window.closeNoteModal = function (e) {
    if (e.target === $("noteOverlay")) $("noteOverlay").style.display = "none";
  };
  window.saveNote = async function () {
    if (!currentNoteAppId) return;
    const recNote = $("noteTextarea").value.trim();
    try {
      await updateDoc(doc(db, "applications", currentNoteAppId), {
        rec_note: recNote,
        note_updated_at: serverTimestamp()
      });
      const app = allApplications.find(a => a.id === currentNoteAppId);
      if (app) app.rec_note = recNote;
      renderCards();
      $("noteOverlay").style.display = "none";
      showToast("Note saved", "success");
    } catch {
      showToast("Failed to save note", "error");
    }
  };

  window.openProfile = async function (appId) {
    const app = allApplications.find(a => a.id === appId);
    if (!app) return;

    if (app.rec_unread) {
      await updateDoc(doc(db, "applications", appId), { rec_unread: false }).catch(() => {});
    }

    const overlay = $("profileOverlay");
    const content = $("profileContent");
    overlay.style.display = "flex";

    const history = app.status_history || [];
    const timelineHTML = history.length ? history.map(h => `
      <div class="tl-item">
        <div class="tl-dot" style="color:${statusColor(h.status)}">${statusIcon(h.status)}</div>
        <div class="tl-body">
          <div class="tl-label">${escHtml(STATUS_LABELS[h.status] || h.status)}</div>
          <div class="tl-time">${h.at?.toDate ? timeSince(h.at.toDate()) : ""}</div>
          ${h.note ? `<div class="tl-note">"${escHtml(h.note)}"</div>` : ""}
        </div>
      </div>`).join("") :
      `<div class="tl-item">
        <div class="tl-dot" style="color:${statusColor(app.status || "applied")}">${statusIcon(app.status || "applied")}</div>
        <div class="tl-body">
          <div class="tl-label">${escHtml(STATUS_LABELS[app.status || "applied"])}</div>
          <div class="tl-time">Current status</div>
        </div>
      </div>`;

    content.innerHTML = `
      <h2 style="margin:0 0 4px;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(app.candidateName)}</h2>
      <p style="margin:0 0 20px;color:var(--text-3, #6b7fa8);font-size:13px;">${escHtml(app.candidateRole || "Candidate")}</p>

      <div class="prof-row">
        ${app.candidateEmail ? `<div class="prof-field"><label>Email</label><p>${escHtml(app.candidateEmail)}</p></div>` : ""}
        <div class="prof-field"><label>Applied For</label><p>${escHtml(app.jobTitle)}</p></div>
        <div class="prof-field"><label>Applied</label><p>${app.applied_at?.toDate ? app.applied_at.toDate().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "Unknown"}</p></div>
      </div>

      ${app.note ? `
      <div style="margin-bottom:18px;">
        <div class="prof-field"><label>Candidate's Cover Note</label></div>
        <div class="app-note-preview" style="white-space:normal;font-style:italic;color:var(--text-2, #a0aec0);">${escHtml(app.note)}</div>
      </div>` : ""}

      ${app.rec_note ? `
      <div style="margin-bottom:18px;">
        <div class="prof-field"><label>Your Private Note</label></div>
        <div class="app-note-preview" style="white-space:normal;border-left-color:rgba(192,132,252,.4);color:var(--purple, #c084fc);font-style:normal;">${escHtml(app.rec_note)}</div>
      </div>` : ""}

      ${app.resumeText ? `
      <div style="margin-bottom:18px;">
        <div class="prof-field"><label>Resume Snippet</label></div>
        <div style="background:var(--surface, #090e1c);border:1px solid rgba(122,162,255,.1);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-2, #a0aec0);line-height:1.6;max-height:120px;overflow-y:auto;">
          ${escHtml(app.resumeText.slice(0, 600))}${app.resumeText.length > 600 ? "…" : ""}
        </div>
      </div>` : ""}

      <div style="height:1px;background:rgba(122,162,255,.08);margin-bottom:18px;"></div>

      <div class="prof-field" style="margin-bottom:12px;"><label>Application Timeline</label></div>
      <div class="timeline">${timelineHTML}</div>

      <div class="bm-btn-row" style="margin-top:20px;">
        ${safeMailto(app.candidateEmail, `Re: Your application for ${app.jobTitle || ""}`) ? `
        <button class="bm-btn" data-mailto="${escAttr(safeMailto(app.candidateEmail, `Re: Your application for ${app.jobTitle || ""}`))}" onclick="window.location.href=this.dataset.mailto">
          ✉ Email Candidate
        </button>` : ""}
        <button class="bm-btn primary" data-candidate-id="${escAttr(app.candidate_id)}" data-cand-name="${escAttr(app.candidateName)}" data-job-id="${escAttr(app.job_id)}" onclick="openCandidateAnalysis(this.dataset.candidateId,this.dataset.candName,this.dataset.jobId)">
          🔍 Deep Analysis
        </button>
      </div>
    `;
  };
  window.closeProfileModal = function (e) {
    if (e.target === $("profileOverlay")) $("profileOverlay").style.display = "none";
  };

  function subscribeNotifications(recruiterId) {
    const q = query(
      collection(db, "notifications"),
      where("to_user_id", "==", recruiterId),
      where("to_role", "==", "recruiter"),
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
        list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
        return;
      }
      list.innerHTML = notifs.map(n => `
        <div class="notif-item ${n.read ? "" : "unread"}" data-id="${escAttr(n.id)}" onclick="markNotifRead(this.dataset.id)">
          <div>${escHtml(n.message || "New activity on your job.")}</div>
          <div class="notif-time">${escHtml(n.created_at?.toDate ? timeSince(n.created_at.toDate()) : "Recently")}</div>
        </div>`).join("");
    });
  }

  window.markNotifRead = async function (notifId) {
    await updateDoc(doc(db, "notifications", notifId), { read: true }).catch(() => {});
  };
  window.markAllRead = async function () {
    const user = auth.currentUser;
    if (!user) return;
    const q = query(collection(db, "notifications"), where("to_user_id", "==", user.uid), where("read", "==", false));
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

  $("searchInput")?.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderCards();
  });
}


/* =========================================================
   ===================  REC-LEADS.HTML  ====================
   Bulk freelance-lead-to-resume matching. Gated to the single
   Beyond Match recruiter account via server-issued custom claims
   (see window._isBeyondMatchRecruiter in auth.js).
========================================================= */
if ($("leadsGrid")) {
  (function showInstantSkeletons() {
    const grid = $("leadsGrid");
    const skel = () => `
      <div class="skeleton-lead-card">
        <div class="skel skel-h20 skel-w60"></div>
        <div class="skel skel-h14 skel-w40"></div>
        <div class="skel skel-h14 skel-w80"></div>
        <div class="skel skel-h34"></div>
      </div>`;
    grid.innerHTML = Array(6).fill(null).map(skel).join("");
  })();

  let allLeads = [];
  let resumeTokens = null;
  let activeView = "all";
  const STOPWORDS = new Set(["the","and","for","with","this","that","from","have","will","your","you","are","not","but","all","any","can","our","was","were","has","had","its","a","an","of","to","in","on","at","is","be","as","by","or","if","we","i","you're","i'm"]);

  function tokenize(text) {
    return (text || "").toLowerCase().match(/[a-z][a-z0-9+.#]{1,}/g) || [];
  }

  // Simple, transparent keyword-overlap score (no backend call needed).
  function scoreLead(lead) {
    if (!resumeTokens) return null;
    const jobTokens = tokenize(`${lead.title || ""} ${lead.description || ""}`)
      .filter(t => !STOPWORDS.has(t) && t.length > 2);
    if (!jobTokens.length) return 0;
    const jobSet = new Set(jobTokens);
    let overlap = 0;
    jobSet.forEach(t => { if (resumeTokens.has(t)) overlap++; });
    const pct = Math.round((overlap / jobSet.size) * 100);
    return Math.min(98, Math.max(2, pct));
  }

  window.analyzeResumeAgainstLeads = async function () {
    const fileInput = $("resumeFile");
    const statusEl = $("uploadStatus");
    const file = fileInput.files?.[0];

    if (!file) {
      statusEl.textContent = "Choose a PDF or DOCX file first.";
      statusEl.className = "upload-status err";
      return;
    }

    const btn = $("analyzeBtn");
    btn.disabled = true;
    btn.textContent = "Analyzing…";
    statusEl.textContent = "";
    statusEl.className = "upload-status";

    try {
      const text = await parseResumeFile(file).catch(() => null) || "";
      if (!text.trim()) throw new Error("Couldn't extract any text from that file.");

      resumeTokens = new Set(tokenize(text).filter(t => !STOPWORDS.has(t) && t.length > 2));

      statusEl.textContent = `✓ Resume analyzed — ${allLeads.length} leads scored`;
      statusEl.className = "upload-status ok";

      $("matchedToggleBtn").disabled = false;
      $("matchedToggleBtn").title = "";
      $("matchFilter").disabled = false;
      $("clearBtn").style.display = "inline-flex";

      renderLeads();
    } catch (err) {
      logError("resume read failed", err);
      statusEl.textContent = "✕ Could not read that resume. Please try another file.";
      statusEl.className = "upload-status err";
    } finally {
      btn.disabled = false;
      btn.textContent = "Analyze Resume";
    }
  };

  window.clearResumeMatching = function () {
    resumeTokens = null;
    activeView = "all";
    document.querySelectorAll("#viewToggle .toggle-pill").forEach(b => b.classList.remove("active"));
    document.querySelector('#viewToggle [data-view="all"]').classList.add("active");
    $("matchedToggleBtn").disabled = true;
    $("matchedToggleBtn").title = "Upload a resume to enable";
    $("matchFilter").disabled = true;
    $("matchFilter").value = "";
    $("clearBtn").style.display = "none";
    $("uploadStatus").textContent = "";
    $("resumeFile").value = "";
    renderLeads();
  };

  function ringColor(pct) {
    if (pct >= 70) return "var(--green, #4ade80)";
    if (pct >= 50) return "var(--blue, #7aa2ff)";
    return "var(--amber, #fbbf24)";
  }

  function leadCard(lead, idx) {
    const pct = scoreLead(lead);
    const hasScore = pct !== null;
    const isTop = hasScore && pct >= 70;

    const dashOffset = hasScore ? (113 - (113 * pct) / 100) : 113;
    const ringHTML = hasScore ? `
      <div class="match-ring">
        <svg viewBox="0 0 44 44">
          <circle class="ring-bg" cx="22" cy="22" r="18"/>
          <circle class="ring-fill" cx="22" cy="22" r="18" stroke="${ringColor(pct)}"
            stroke-dashoffset="${dashOffset}"/>
        </svg>
        <div class="match-ring-label">${pct}%</div>
      </div>` : "";

    const budget = (lead.salary_min || lead.salary_max)
      ? `Avg Bid: $${Math.round(lead.salary_min || lead.salary_max).toLocaleString()}`
      : "Budget not disclosed";

    const desc = (lead.description || "").slice(0, 220);
    const applyUrl = safeUrl(lead.apply_url || lead.redirect_url);

    return `
      <div class="lead-card ${isTop ? "top-match" : ""}" data-idx="${idx}">
        ${isTop ? `<div class="top-badge">★ Strong Match</div>` : ""}
        <div class="lead-header">
          <div>
            <div class="lead-title">${escHtml(lead.title || "Untitled Project")}</div>
            <div class="lead-sub">Freelancer.com · Remote</div>
          </div>
          ${ringHTML}
        </div>
        <div class="lead-meta">
          <span class="meta-chip">📍 Remote</span>
        </div>
        <div class="lead-budget">${escHtml(budget)}</div>
        <div class="lead-desc">${escHtml(desc)}${(lead.description || "").length > 220 ? "…" : ""}</div>
        <div class="lead-insight" id="insight-${idx}"></div>
        <div class="lead-actions">
          <a class="lead-btn open" href="${escAttr(safeUrl(applyUrl) || "#")}" target="_blank" rel="noopener"
             ${!applyUrl ? 'onclick="return false;" style="opacity:.5;cursor:not-allowed;"' : ""}>
            🔗 Open Project
          </a>
          <button class="lead-btn copy" onclick="window.copyLeadLink(${idx}, this)">📋 Copy Link</button>
          <button class="lead-btn know" onclick="window.knowMoreAboutLead(${idx}, this)">✨ Know More</button>
        </div>
      </div>`;
  }

  window.copyLeadLink = function (idx, btn) {
    const lead = allLeads[idx];
    const url = lead.apply_url || lead.redirect_url || "";
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      const original = btn.textContent;
      btn.textContent = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1800);
    });
  };

  window.knowMoreAboutLead = async function (idx, btn) {
    const lead = allLeads[idx];
    const box = $(`insight-${idx}`);
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Thinking…";
    box.style.display = "block";
    box.textContent = "Generating a quick summary…";

    const prompt = `In 2 short sentences, summarize this freelance project for a recruiter deciding whether to bid on it, and note what kind of freelancer would be a good fit. Title: "${lead.title}". Description: "${(lead.description || "").slice(0, 500)}"`;

    try {
      const result = await callGemini(prompt, "candidate_analysis");
      box.textContent = result || "Couldn't generate a summary right now.";
    } catch {
      box.textContent = "Couldn't generate a summary right now.";
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  function renderLeads() {
    const grid = $("leadsGrid");
    let filtered = [...allLeads];

    const searchTerm = $("leadSearch").value.trim().toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter(l =>
        (l.title || "").toLowerCase().includes(searchTerm) ||
        (l.description || "").toLowerCase().includes(searchTerm));
    }

    if (activeView === "matched" && resumeTokens) {
      filtered = filtered.filter(l => (scoreLead(l) ?? 0) > 0);
    }

    const matchMin = $("matchFilter").value;
    if (matchMin && resumeTokens) {
      filtered = filtered.filter(l => (scoreLead(l) ?? 0) >= Number(matchMin));
    }

    if (resumeTokens) {
      filtered.sort((a, b) => (scoreLead(b) ?? 0) - (scoreLead(a) ?? 0));
    }

    const budgetSort = $("budgetSort").value;
    if (budgetSort === "high") {
      filtered.sort((a, b) => (Number(b.salary_min || b.salary_max || 0)) - (Number(a.salary_min || a.salary_max || 0)));
    } else if (budgetSort === "low") {
      filtered.sort((a, b) => (Number(a.salary_min || a.salary_max || 0)) - (Number(b.salary_min || b.salary_max || 0)));
    }

    $("leadsCount").textContent = `${filtered.length} of ${allLeads.length} lead${allLeads.length === 1 ? "" : "s"}`;

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <h4>No leads match right now</h4>
          <p>Try clearing filters or search.</p>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map(lead => {
      const originalIdx = allLeads.indexOf(lead);
      return leadCard(lead, originalIdx);
    }).join("");
  }

  $("leadSearch").addEventListener("input", renderLeads);
  $("matchFilter").addEventListener("change", renderLeads);
  $("budgetSort").addEventListener("change", renderLeads);
  $("viewToggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle-pill");
    if (!btn || btn.disabled) return;
    document.querySelectorAll("#viewToggle .toggle-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeView = btn.dataset.view;
    renderLeads();
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    // Fails closed if auth.js's shared gate isn't available
    const eligible = window._isBeyondMatchRecruiter
      ? await window._isBeyondMatchRecruiter(user).catch(() => false)
      : false;

    if (!eligible) {
      $("deniedBox").style.display = "block";
      return;
    }

    $("leadsContent").style.display = "block";

    try {
      const jobs = await getJobs();
      allLeads = jobs.filter(j => (j.source || "").toLowerCase() === "freelancer");
    } catch {
      allLeads = [];
    }

    renderLeads();
  });
}


/* =========================================================
   =================  REC-LOCATEHIRE.HTML  =================
   Recruiter-facing candidate map. Green markers = candidates
   matched to at least one of the recruiter's org jobs.
========================================================= */
if ($("map") && $("cityPanel") && $("panelTitle")?.textContent === "Candidates") {
  let _matchedCandidateIds = new Set();
  let _candidateMatchMap = {}; // candidate_id -> [{match_percent, job_id, job_title, company}]
  let _recruiterOrg = null;
  let _entityMap = null;

  async function loadMatchedCandidateIds() {
    try {
      // SEC-17: the candidate match results are fetched each time and kept in
      // memory only (module variables), not in browser storage.

      const user = auth.currentUser || await new Promise(resolve => {
        const unsub = onAuthStateChanged(auth, u => { unsub(); resolve(u); });
      });
      if (!user) return;

      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) return;
      _recruiterOrg = snap.data().organisation_name || null;
      if (!_recruiterOrg) return;

      const jobs = await getJobsByCompany(_recruiterOrg);
      if (!jobs.length) return;

      const allMatchArrays = await Promise.all(
        jobs.map(async j => {
          try {
            const { matches } = await getMatches({ job_id: j.job_id, top_n: 50, offset: 0 });
            return matches.map(m => {
              let pct = m.match_percent ?? m.match_score ?? null;
              if (pct == null && m.score != null) pct = m.score * 100;
              pct = pct != null ? Math.round(pct) : null;
              return {
                candidate_id: String(m.candidate_id),
                match_percent: pct,
                job_id: j.job_id,
                job_title: j.title || j.role || "Open Role",
                company: j.company || _recruiterOrg || ""
              };
            });
          } catch { return []; }
        })
      );

      _candidateMatchMap = {};
      for (const arr of allMatchArrays) {
        for (const m of arr) {
          // Store under both raw + numeric string form so lookups succeed
          // whether the doc-ID is a UUID or an integer-like string.
          const keys = new Set([String(m.candidate_id)]);
          const asNum = String(Number(m.candidate_id));
          if (asNum !== "NaN") keys.add(asNum);
          for (const key of keys) {
            if (!_candidateMatchMap[key]) _candidateMatchMap[key] = [];
            _candidateMatchMap[key].push(m);
          }
        }
      }
      for (const id of Object.keys(_candidateMatchMap)) {
        _candidateMatchMap[id].sort((a, b) => b.match_percent - a.match_percent);
      }
      _matchedCandidateIds = new Set(Object.keys(_candidateMatchMap));

    } catch { /* leave maps empty — map still renders unmatched */ }
  }

  function buildTooltipHTML(candidates) {
    const country = resolveCountryLabel(candidates);
    const count = candidates.length;
    const matchCount = candidates.filter(c => _matchedCandidateIds.has(String(c.candidate_id))).length;
    const hasMatch = matchCount > 0;

    const accent = hasMatch ? "#4ade80" : "#7aa2ff";
    const accentDim = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
    const accentLine = hasMatch ? "rgba(74,222,128,0.18)" : "rgba(122,162,255,0.18)";
    const accentRoleB = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
    const accentRole = hasMatch ? "rgba(74,222,128,0.05)" : "rgba(122,162,255,0.05)";
    const textCol = hasMatch ? "#b9ffd4" : "#c8d8ff";

    const roleFreq = {};
    candidates.forEach(c => {
      const r = c.applied_role || c.role || "Unknown";
      roleFreq[r] = (roleFreq[r] || 0) + 1;
    });
    const topRoles = Object.entries(roleFreq).sort((a, b) => b[1] - a[1]).slice(0, 3);

    const rolesHTML = topRoles.map(([role, n]) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:${accentRole};border:1px solid ${accentRoleB};border-radius:6px;">
        <span style="font-size:11.5px;font-weight:600;color:${textCol};">${escHtml(role)}</span>
        <span style="font-size:10px;color:${accent};font-weight:700;margin-left:8px;">${n}</span>
      </div>`).join("");

    const matchBadge = hasMatch ? `
      <div style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;color:var(--green, #4ade80);background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);border-radius:5px;padding:2px 7px;margin-bottom:8px;letter-spacing:0.05em;text-transform:uppercase;">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="var(--green, #4ade80)"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        ${matchCount} org match${matchCount !== 1 ? "es" : ""}
      </div>` : "";

    return `
      <div style="background:#0b0e1a;border:1px solid ${accentLine};border-radius:12px;padding:12px 14px;width:220px;box-shadow:0 16px 48px rgba(0,0,0,0.7),inset 0 1px 0 rgba(122,162,255,0.08);font-family:'DM Sans',sans-serif;backdrop-filter:blur(12px);">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
          <div style="width:24px;height:24px;border-radius:7px;background:${accentDim};border:1px solid ${accentLine};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="${accent}"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--text-1, #e2e8f0);letter-spacing:-0.01em;">${escHtml(country)}</div>
            <div style="font-size:10px;color:${accent};margin-top:1px;">${count} candidate${count !== 1 ? "s" : ""}</div>
          </div>
        </div>
        ${matchBadge}
        <div style="height:1px;background:${accentRoleB};margin-bottom:8px;"></div>
        <div style="font-size:9.5px;font-weight:700;color:var(--text-muted, #4a5580);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Top Roles</div>
        <div style="display:flex;flex-direction:column;gap:4px;">${rolesHTML}</div>
        <div style="margin-top:9px;text-align:right;font-size:10px;color:#3a4568;letter-spacing:0.03em;">Click to explore →</div>
      </div>`;
  }

  function showCandidatesForLocation(title, candidates) {
    const panel = $("cityPanel");
    const grid = $("panelGrid");
    const heading = $("panelTitle");
    const count = $("panelCount");

    panel.classList.remove("hidden");
    heading.textContent = title;

    const enriched = candidates.map(c => {
      const idStr = String(c.candidate_id ?? "");
      const idNum = String(Number(idStr));
      const matches = _candidateMatchMap[idStr] ||
        (_candidateMatchMap[idNum] && idNum !== "NaN" ? _candidateMatchMap[idNum] : null) || [];
      const isMatch = _matchedCandidateIds.has(idStr) || (_matchedCandidateIds.has(idNum) && idNum !== "NaN");
      const best = matches[0] || null;
      return { ...c, _isMatch: isMatch, _best: best, _matches: matches };
    });

    const matched = enriched.filter(c => c._isMatch)
      .sort((a, b) => (b._best?.match_percent ?? -1) - (a._best?.match_percent ?? -1));
    const unmatched = enriched.filter(c => !c._isMatch)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const ordered = [...matched, ...unmatched];

    if (count) {
      count.textContent = `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${matched.length ? ` · ${matched.length} org match${matched.length === 1 ? "" : "es"}` : ""}`;
    }

    let html = "";

    if (!candidates.length) {
      grid.innerHTML = `
        <div class="panel-placeholder">
          <div class="placeholder-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <h4>No candidates here</h4>
          <p>No candidates available for this location.</p>
        </div>`;
      return;
    }

    if (matched.length > 0) {
      html += `
        <div class="panel-section-divider panel-section-matched" style="margin-top:0;border-top:none;padding-top:0;margin-bottom:8px;">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--green, #4ade80)" style="vertical-align:-1px;margin-right:4px;">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          Org Matches
        </div>`;
    }

    ordered.forEach((cand, i) => {
      const isMatch = cand._isMatch;
      const best = cand._best;

      if (i === matched.length && unmatched.length > 0 && matched.length > 0) {
        html += `<div class="panel-section-divider" style="margin-top:6px;margin-bottom:8px;">Other Candidates</div>`;
      }

      const candName = cand.name || "Candidate";
      const candRole = cand.applied_role || cand.role || "—";
      const location = cand.location_display || cand.location || cand.city || "Location not specified";

      const jobTitle = best?.job_title || "—";
      const company = best?.company || _recruiterOrg || "—";
      const pct = best?.match_percent;

      let matchRingHTML = "";
      if (isMatch) {
        const hasPct = pct != null;
        const displayPct = hasPct ? pct : "?";
        const ringColor = !hasPct ? "var(--text-3, #6b7fa8)" : pct >= 75 ? "var(--green, #4ade80)" : pct >= 50 ? "var(--amber, #fbbf24)" : "var(--blue, #7aa2ff)";
        const circumference = 2 * Math.PI * 15;
        const dash = hasPct ? ((pct / 100) * circumference).toFixed(1) : "0";
        const gap = hasPct ? (circumference - +dash).toFixed(1) : circumference.toFixed(1);
        matchRingHTML = `
          <div style="position:relative;width:48px;height:48px;flex-shrink:0;" title="${escAttr(hasPct ? pct + "% match" : "Match % unavailable")}">
            <svg width="48" height="48" viewBox="0 0 48 48" style="transform:rotate(-90deg);">
              <circle cx="24" cy="24" r="15" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="3.5"/>
              <circle cx="24" cy="24" r="15" fill="none" stroke="${ringColor}" stroke-width="3.5"
                stroke-dasharray="${dash} ${gap}" stroke-linecap="round"/>
            </svg>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:0;">
              <span style="font-size:${hasPct ? "11" : "10"}px;font-weight:800;color:${ringColor};line-height:1;">${escHtml(displayPct)}${hasPct ? "%" : ""}</span>
            </div>
          </div>`;
      }

      let extraPillsHTML = "";
      if (isMatch && (cand._matches || []).length > 1) {
        const pills = cand._matches.slice(1).map(m => {
          const c = m.match_percent >= 75 ? "var(--green, #4ade80)" : m.match_percent >= 50 ? "var(--amber, #fbbf24)" : "var(--blue, #7aa2ff)";
          const pStr = m.match_percent != null ? `${m.match_percent}%` : "?%";
          return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(122,162,255,0.07);border:1px solid rgba(122,162,255,0.14);color:var(--text-3, #8fa8cc);">
            ${escHtml(m.job_title)}<span style="color:${c};font-weight:700;margin-left:2px;">${escHtml(pStr)}</span>
          </span>`;
        }).join("");
        extraPillsHTML = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;">${pills}</div>`;
      }

      html += `
        <div class="panel-job-card${isMatch ? " panel-job-matched" : ""}" style="animation-delay:${i * 40}ms;padding:12px 14px;">
          ${isMatch ? `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
              <span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--green, #4ade80);background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.22);border-radius:4px;padding:1px 7px;flex-shrink:0;">${escHtml(company)}</span>
              <span style="font-size:11px;font-weight:600;color:var(--text-2, #c8d8ff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(jobTitle)}">↳ ${escHtml(jobTitle)}</span>
            </div>
          </div>` : ""}

          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;background:${isMatch ? "linear-gradient(135deg,rgba(74,222,128,0.25),rgba(74,222,128,0.1))" : "linear-gradient(135deg,rgba(122,162,255,0.18),rgba(122,162,255,0.06))"};border:1px solid ${isMatch ? "rgba(74,222,128,0.2)" : "rgba(122,162,255,0.12)"};">
              ${escHtml(candName.charAt(0).toUpperCase())}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:700;color:var(--text-1, #e2e8f0);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(candName)}</div>
              <div style="font-size:11px;color:var(--text-3, #6b7fa8);margin-top:2px;display:flex;align-items:center;gap:4px;">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
                <span>${escHtml(candRole)}</span>
              </div>
            </div>
            ${matchRingHTML}
          </div>

          ${extraPillsHTML}

          <div style="display:flex;align-items:center;gap:4px;margin-top:9px;margin-bottom:10px;">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--text-3, #6b7fa8)" stroke-width="2" style="flex-shrink:0;">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            <span style="font-size:10px;color:var(--text-3, #6b7fa8);">${escHtml(location)}</span>
          </div>

          <button class="panel-apply-btn"
            data-candidate-id="${escAttr(cand.candidate_id)}" data-cand-name="${escAttr(candName)}"
            data-job-title="${escAttr(jobTitle)}" data-company="${escAttr(company)}" data-pct="${escAttr(pct ?? "")}"
            onclick="const d=this.dataset;openCandidateProfileModal(d.candidateId,d.candName,d.jobTitle,d.company,d.pct === '' || isNaN(Number(d.pct)) ? null : Number(d.pct))"
            style="${isMatch ? "background:linear-gradient(135deg,rgba(74,222,128,0.15),rgba(74,222,128,0.06));border-color:rgba(74,222,128,0.3);color:var(--green, #4ade80);" : ""}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            View Profile →
          </button>
        </div>`;
    });

    grid.innerHTML = html;
  }

  window.closeCityPanel = function () {
    $("cityPanel")?.classList.add("hidden");
    const grid = $("panelGrid");
    if (grid) grid.innerHTML = "";
  };

  async function loadCandidatesAndMarkers() {
    // SEC-06: never download the whole candidates collection. The map shows
    // only the candidates the backend matched to this recruiter's org jobs,
    // fetched one document at a time by id (Firestore rules also deny a
    // collection-wide read to recruiters).
    await loadMatchedCandidateIds();

    const ids = [...new Set(
      Object.values(_candidateMatchMap).flat().map(m => String(m.candidate_id))
    )];
    let candidates = [];
    try {
      const snaps = await Promise.all(ids.map(async id => {
        try { return await getDoc(doc(db, "candidates", id)); } catch { return null; }
      }));
      candidates = snaps
        .filter(snap => snap && snap.exists())
        .map(snap => ({ candidate_id: snap.id, ...snap.data() }))
        .filter(c => c.is_latest !== false);
    } catch { /* leave empty */ }

    if (!candidates.length) return;

    // Candidates missing a location entirely fall back to a default city
    // rather than being dropped from the map — matches original behavior.
    candidates.forEach(c => {
      if (!(c.location_display || c.location || (c.city && c.country) || c.city || c.country)) {
        c.location_display = "Bangalore, India";
      }
    });

    _entityMap = createEntityMap({
      containerId: "map",
      geocodeSensitive: true, // SEC-17: candidates' locations never go to a third party or into storage
      getEntityId: c => String(c.candidate_id),
      getLocationKey: c => c.city || c.location_display || "Candidates",
      getLatLng: c => (c.lat && c.lng) ? { lat: c.lat, lng: c.lng } : null,
      getLocationString: c => c.location_display || c.location ||
        (c.city && c.country ? `${c.city}, ${c.country}` : c.city || c.country || null),
      buildTooltipHTML,
      onMarkerClick: showCandidatesForLocation,
      matchedIds: _matchedCandidateIds
    });

    await _entityMap.addEntities(candidates);
    _entityMap.refreshMarkerStyles(_matchedCandidateIds);

    // Auto-zoom if every candidate is in one country
    const allMarkers = [];
    _entityMap.markersLayer.eachLayer(m => { if (m._bmEntities) allMarkers.push(m); });
    if (allMarkers.length) {
      const extractCountry = marker => {
        const loc = marker._bmEntities[0]?.location_display || marker._bmEntities[0]?.location || marker._bmEntities[0]?.city || "";
        const parts = loc.split(",").map(s => s.trim());
        return parts[parts.length - 1] || "";
      };
      const countries = new Set(allMarkers.map(extractCountry).filter(Boolean));
      if (countries.size === 1) {
        const bounds = L.latLngBounds(allMarkers.map(m => m.getLatLng()));
        _entityMap.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 8, animate: true });
        setTimeout(() => {
          const first = allMarkers[0];
          if (first) showCandidatesForLocation(first._bmTitle || [...countries][0], allMarkers.flatMap(m => m._bmEntities));
        }, 600);
      }
    }
  }

  /* ── Candidate profile modal ── */
  (function injectCandProfileModal() {
    const style = document.createElement("style");
    style.textContent = `
      #bmCandProfileOverlay {
        display:none; position:fixed; inset:0; background:rgba(0,0,0,0.78);
        backdrop-filter:blur(6px); z-index:1000; align-items:center; justify-content:center;
        padding:20px; box-sizing:border-box;
      }
      #bmCandProfileOverlay.open { display:flex; }
      #bmCandProfileModal {
        background:var(--surface, #0f1220); border:1px solid rgba(122,162,255,0.15);
        border-radius:16px; width:100%; max-width:560px; max-height:88vh; overflow-y:auto;
        padding:28px; box-sizing:border-box; position:relative; color:var(--text-1, #e2e8f0);
      }
      .bm-cpm-close {
        position:absolute; top:14px; right:16px; background:none; border:none;
        color:var(--text-muted, #4a5580); font-size:20px; cursor:pointer; line-height:1; transition:color .15s;
      }
      .bm-cpm-close:hover { color:var(--text-1, #e2e8f0); }
      .bm-cpm-label { font-size:11px; color:var(--blue, #7aa2ff); font-weight:700; letter-spacing:1px; text-transform:uppercase; }
      .bm-cpm-field { margin-bottom:12px; }
      .bm-cpm-field label, .bm-cpm-label { display:block; margin-bottom:3px; }
      .bm-cpm-field p { margin:0; font-size:13.5px; color:var(--text-2, #c9d5e8); }
      .bm-cpm-divider { height:1px; background:rgba(122,162,255,.08); margin:16px 0; }
      .bm-cpm-btn-row { display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; margin-top:20px; }
      .bm-cpm-btn {
        font-family:inherit; font-size:13px; font-weight:600; padding:9px 18px;
        border-radius:9px; cursor:pointer; border:1px solid rgba(122,162,255,.22);
        background:transparent; color:var(--blue, #7aa2ff); transition:all .18s;
      }
      .bm-cpm-btn:hover { background:rgba(122,162,255,.1); }
      .bm-cpm-btn.primary { background:rgba(122,162,255,.14); border-color:rgba(122,162,255,.4); }
      .bm-cpm-btn.primary:hover { background:rgba(122,162,255,.22); }
      .bm-cpm-match-pills { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
      .bm-cpm-pill {
        display:inline-flex; align-items:center; gap:5px; font-size:11px; padding:3px 10px;
        border-radius:20px; background:rgba(122,162,255,.07); border:1px solid rgba(122,162,255,.14); color:var(--text-3, #8fa8cc);
      }
      .bm-cpm-pill .pct { font-weight:700; }
      @keyframes bmCpmFadeIn { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
      #bmCandProfileModal { animation: bmCpmFadeIn .22s ease both; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "bmCandProfileOverlay";
    overlay.innerHTML = `
      <div id="bmCandProfileModal">
        <button class="bm-cpm-close" id="bmCandProfileClose">✕</button>
        <span class="bm-cpm-label">Candidate Profile</span>
        <div id="bmCandProfileContent">
          <div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:var(--text-3, #6b7280);font-size:14px;">
            <div style="width:18px;height:18px;border-radius:50%;border:2px solid var(--blue, #7aa2ff);border-top-color:transparent;animation:recSpin .8s linear infinite;flex-shrink:0;"></div>
            Loading candidate…
          </div>
          <style>@keyframes recSpin{to{transform:rotate(360deg)}}</style>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });
    $("bmCandProfileClose").addEventListener("click", () => overlay.classList.remove("open"));
  })();

  window.openCandidateProfileModal = async function (candidateId, nameHint, jobTitleHint, companyHint, matchPct) {
    const overlay = $("bmCandProfileOverlay");
    const content = $("bmCandProfileContent");
    if (!overlay || !content) return;

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:var(--text-3, #6b7280);font-size:14px;">
        <div style="width:18px;height:18px;border-radius:50%;border:2px solid var(--blue, #7aa2ff);border-top-color:transparent;animation:recSpin .8s linear infinite;flex-shrink:0;"></div>
        Loading candidate…
      </div>`;
    overlay.classList.add("open");

    let cand = {};
    try {
      const snap = await getDoc(doc(db, "candidates", String(candidateId)));
      if (snap.exists()) cand = snap.data();
    } catch { /* use hints as fallback */ }

    const name = cand.name || nameHint || "Candidate";
    const role = cand.applied_role || cand.role || "—";
    const email = cand.email || "";
    const location = cand.location_display || cand.location || cand.city || "Location not specified";
    const resumeText = cand.resume_text || cand.resumeText || "";

    const idStr = String(candidateId);
    const matches = _candidateMatchMap[idStr] || _candidateMatchMap[String(Number(idStr))] || [];
    const bestJob = matches[0] || null;
    const jobTitle = bestJob?.job_title || jobTitleHint || "—";
    const company = bestJob?.company || companyHint || _recruiterOrg || "—";
    const pct = bestJob?.match_percent ?? matchPct;

    const ringColorVal = pct == null ? "var(--text-3, #6b7fa8)" : pct >= 75 ? "var(--green, #4ade80)" : pct >= 50 ? "var(--amber, #fbbf24)" : "var(--blue, #7aa2ff)";
    const pctLabel = pct != null ? `${pct}%` : "?%";

    const matchPillsHTML = matches.length ? `
      <div class="bm-cpm-match-pills">
        ${matches.map(m => {
          const c = m.match_percent >= 75 ? "var(--green, #4ade80)" : m.match_percent >= 50 ? "var(--amber, #fbbf24)" : "var(--blue, #7aa2ff)";
          return `<span class="bm-cpm-pill">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
            ${escHtml(m.job_title)}
            <span class="pct" style="color:${c};">${escHtml(m.match_percent != null ? m.match_percent + "%" : "?%")}</span>
          </span>`;
        }).join("")}
      </div>` : "";

    const resumeHTML = resumeText ? `
      <div class="bm-cpm-field">
        <span class="bm-cpm-label">Resume Snippet</span>
        <div style="background:var(--surface, #090e1c);border:1px solid rgba(122,162,255,.1);border-radius:10px;
                    padding:12px 14px;font-size:12px;color:var(--text-2, #a0aec0);line-height:1.6;
                    max-height:130px;overflow-y:auto;">
          ${escHtml(resumeText.slice(0, 700))}${resumeText.length > 700 ? "…" : ""}
        </div>
      </div>` : "";

    content.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px;">
        <div>
          <h2 style="margin:0 0 3px;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(name)}</h2>
          <p style="margin:0;color:var(--text-3, #6b7fa8);font-size:13px;display:flex;align-items:center;gap:5px;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
            ${escHtml(role)}
          </p>
        </div>
        ${pct != null ? `
        <div style="position:relative;width:54px;height:54px;flex-shrink:0;" title="${escAttr(pct)}% match">
          <svg width="54" height="54" viewBox="0 0 54 54" style="transform:rotate(-90deg);">
            <circle cx="27" cy="27" r="20" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="4"/>
            <circle cx="27" cy="27" r="20" fill="none" stroke="${ringColorVal}" stroke-width="4"
              stroke-dasharray="${((pct / 100) * 2 * Math.PI * 20).toFixed(1)} ${((1 - pct / 100) * 2 * Math.PI * 20).toFixed(1)}"
              stroke-linecap="round"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
            <span style="font-size:12px;font-weight:800;color:${ringColorVal};">${escHtml(pctLabel)}</span>
          </div>
        </div>` : ""}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        ${email ? `
        <div class="bm-cpm-field">
          <span class="bm-cpm-label">Email</span>
          <p><a href="${escAttr(safeMailto(email) || "#")}" style="color:var(--blue, #7aa2ff);text-decoration:none;">${escHtml(email)}</a></p>
        </div>` : ""}
        <div class="bm-cpm-field">
          <span class="bm-cpm-label">Location</span>
          <p>${escHtml(location)}</p>
        </div>
      </div>

      ${matches.length ? `
      <div class="bm-cpm-field">
        <span class="bm-cpm-label">Matched Org Roles</span>
        <div style="font-size:12px;color:var(--text-3, #6b7fa8);margin-bottom:4px;">${escHtml(company)}</div>
        ${matchPillsHTML}
      </div>` : ""}

      <div class="bm-cpm-divider"></div>

      ${resumeHTML}

      <div class="bm-cpm-btn-row">
        ${safeMailto(email, `Opportunity at ${company}`) ? `
        <button class="bm-cpm-btn" data-mailto="${escAttr(safeMailto(email, `Opportunity at ${company}`))}" onclick="window.location.href=this.dataset.mailto">
          ✉ Email
        </button>` : ""}
        <button class="bm-cpm-btn" onclick="window.location.href='rec-actions.html'">
          ⚡ Recruiter Actions
        </button>
        <button class="bm-cpm-btn primary"
          data-candidate-id="${escAttr(candidateId)}" data-cand-name="${escAttr(nameHint)}" data-job-id="${escAttr(bestJob?.job_id || "")}"
          onclick="window.openCandidateAnalysis && window.openCandidateAnalysis(this.dataset.candidateId,this.dataset.candName,this.dataset.jobId)">
          🔍 Deep Analysis
        </button>
      </div>
    `;
  };

  loadCandidatesAndMarkers();
}


/* =========================================================
   ==================  CAND-MATCHES.HTML  ==================
   Recruiter's view of AI-ranked candidates for a specific job
   posting — despite the "cand" name, this is a recruiter page.
========================================================= */
if ($("candMatchesTable") && $("roleDropdown")) {
  $("candMatchesTable").innerHTML = `
    <div class="empty-state" id="idleState">
      <div class="empty-state-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>
      <h4>Select a role to find candidates</h4>
      <p>Choose a job posting above and click <strong style="color:var(--blue, #7aa2ff);">View Matches</strong>.</p>
    </div>`;

  function showCandSkeletons(count) {
    const grid = $("candMatchesTable");
    if (!grid) return;
    grid.innerHTML = Array(count).fill(null).map(() => `
      <div class="skeleton-card">
        <div class="skel-row">
          <div style="flex:1;">
            <div class="skel skel-h20 skel-w60" style="margin-bottom:6px;"></div>
            <div class="skel skel-h14 skel-w40"></div>
          </div>
          <div class="skel skel-circle"></div>
        </div>
        <div class="skel-row" style="gap:6px;">
          <div class="skel skel-h10" style="width:70px;border-radius:5px;"></div>
          <div class="skel skel-h10" style="width:80px;border-radius:5px;"></div>
          <div class="skel skel-h10" style="width:55px;border-radius:5px;"></div>
        </div>
        <div class="skel skel-h14 skel-w60" style="margin-top:2px;"></div>
        <div class="skel skel-h34" style="width:100%;margin-top:4px;"></div>
        <div class="skel-row" style="gap:8px;margin-top:4px;">
          <div class="skel skel-h34" style="flex:1;"></div>
          <div class="skel skel-h34" style="flex:1;"></div>
        </div>
      </div>`).join("");
  }

  function makeRing(pct) {
    const circ = 113;
    const offset = circ - (pct / 100) * circ;
    const col = pct >= 80 ? "var(--green, #4ade80)" : pct >= 60 ? "var(--blue, #7aa2ff)" : pct >= 40 ? "var(--amber, #fbbf24)" : "var(--red, #f87171)";
    return `
      <div class="match-ring" data-offset="${offset}">
        <svg viewBox="0 0 40 40">
          <circle class="ring-bg" cx="20" cy="20" r="18"/>
          <circle class="ring-fill" cx="20" cy="20" r="18"
            stroke="${col}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"
            fill="none" stroke-width="3.5" stroke-linecap="round"
            style="transform:rotate(-90deg);transform-origin:center"/>
        </svg>
        <div class="match-ring-label">${Math.round(pct)}%</div>
      </div>`;
  }

  function animateRings() {
    document.querySelectorAll(".match-ring[data-offset]").forEach(r => {
      const fill = r.querySelector(".ring-fill");
      if (!fill) return;
      const off = r.dataset.offset;
      requestAnimationFrame(() => setTimeout(() => { fill.style.strokeDashoffset = off; }, 60));
    });
  }

  let allCandidates = [];
  let currentLlmMap = {};
  let currentJobId = null;
  let selectedJobIdForCandidates = null;

  window.triggerLoadCandidates = async function () {
    const jobId = $("roleDropdown")?.value;
    if (!jobId) { showToast("Please select a role first.", "warning"); return; }
    currentJobId = jobId;
    currentLlmMap = {};
    showCandSkeletons(6);
    await loadCandidatesForRole(jobId);
  };

  window.renderCandidateCards = function (candidates, llmMap) {
    allCandidates = candidates || [];
    currentLlmMap = llmMap || {};
    renderGrid(allCandidates, currentLlmMap);
  };

  window.patchCandidateLlm = function (llmMap) {
    currentLlmMap = llmMap;
    document.querySelectorAll("[data-cid]").forEach(card => {
      const llm = llmMap[card.dataset.cid];
      if (!llm) return;

      const ins = card.querySelector("[data-cid-insight]");
      if (ins && llm.recruiter_summary) {
        ins.innerHTML = `<span>✦ ${escHtml(llm.recruiter_summary)}</span>`;
      }

      if (llm.shortlist_flag && !card.querySelector(".ai-top-badge")) {
        const badge = document.createElement("div");
        badge.className = "ai-top-badge";
        badge.textContent = "⭐ AI Recommended";
        card.prepend(badge);
        card.classList.add("ai-shortlist");
      }
    });
  };

  function renderGrid(candidates, llmMap) {
    const grid = $("candMatchesTable");
    if (!grid) return;

    let list = [...candidates];
    const search = $("candSearchInput")?.value.toLowerCase() || "";
    if (search) list = list.filter(c => c.name?.toLowerCase().includes(search) || c.email?.toLowerCase().includes(search));

    const sort = $("candSortSelect")?.value || "score";
    if (sort === "score")  list.sort((a, b) => (b.match_percent || 0) - (a.match_percent || 0));
    if (sort === "name")   list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (sort === "newest") list.sort((a, b) => toSortableDate(b.created_at) - toSortableDate(a.created_at));
    if (sort === "oldest") list.sort((a, b) => toSortableDate(a.created_at) - toSortableDate(b.created_at));

    const countEl = $("matchesCount");
    if (countEl) countEl.textContent = list.length ? `${list.length} candidate${list.length !== 1 ? "s" : ""} found` : "";

    if (!list.length) {
      grid.innerHTML = `<div class="empty-state"><h4>No candidates found</h4><p>Try adjusting your search.</p></div>`;
      return;
    }

    grid.innerHTML = list.map((c, idx) => {
      const pct = parseFloat(c.match_percent || 0);
      const llm = llmMap[c.candidate_id] || {};
      const name = (c.name && c.name !== c.email) ? c.name : (c.email?.split("@")[0] || "Candidate");
      const skills = (c.matched_skills || []).slice(0, 4);

      return `
        <div class="cand-match-card ${llm.shortlist_flag ? "ai-shortlist" : ""}"
             data-cid="${escAttr(c.candidate_id)}" data-cand-name="${escAttr(name)}"
             data-cand-email="${escAttr(c.email || "")}" data-job-id="${escAttr(currentJobId)}"
             style="animation-delay:${idx * 55}ms">
          ${llm.shortlist_flag ? `<div class="ai-top-badge">⭐ AI Recommended</div>` : ""}

          <div class="card-header">
            <div class="card-titles">
              <div class="card-name">${escHtml(name)}</div>
              <div class="card-email">${escHtml(c.email || "—")}</div>
            </div>
            <div class="match-pct">${makeRing(pct)}</div>
          </div>

          ${c.level ? `<div class="level-chip">${escHtml(c.level)}</div>` : ""}

          <div class="card-skills">
            ${skills.length
              ? skills.map(s => `<span class="skill-pill">${escHtml(s)}</span>`).join("")
              : `<span class="skill-pill subtle">No skills listed</span>`}
          </div>

          <div class="card-sep"></div>

          <div class="card-insight" data-cid-insight="${escAttr(c.candidate_id)}">
            ${(() => {
              const txt = llm.recruiter_summary || c.explanation?.top_reason;
              if (txt) return `<span>✦ ${escHtml(txt)}</span>`;
              return `<span style="color:var(--text-muted, #4a5580);font-size:11.5px;font-style:italic;">🔍 Click <strong style="color:var(--blue, #7aa2ff);">Analyse</strong> for full candidate insights</span>`;
            })()}
          </div>

          <div class="card-actions" style="grid-template-columns:1fr 1fr 1fr;">
            <button class="card-btn view"
              onclick="const d=this.closest('.cand-match-card').dataset;openCandProfile(d.cid,d.candName,d.candEmail,d.jobId)">
              👤 Profile
            </button>
            <button class="card-btn invite"
              onclick="const d=this.closest('.cand-match-card').dataset;openInviteModal(d.cid,d.candName,d.candEmail,d.jobId, document.getElementById('roleDropdown').selectedOptions[0].text)">
              ✉ Invite
            </button>
            <button class="card-btn analyse"
              onclick="const d=this.closest('.cand-match-card').dataset;window.openCandidateAnalysis && openCandidateAnalysis(d.cid,d.candName,d.jobId)">
              🔍 Analyse
            </button>
          </div>
        </div>`;
    }).join("");

    animateRings();
  }

  $("candSearchInput")?.addEventListener("input", () => renderGrid(allCandidates, currentLlmMap));
  $("candSortSelect")?.addEventListener("change", () => renderGrid(allCandidates, currentLlmMap));

  async function initCandidateMatchesPage() {
    onAuthStateChanged(auth, async (user) => {
      const container = $("candMatchesTable");
      const roleDropdown = $("roleDropdown");

      if (!user) { container.innerHTML = "User not authenticated."; return; }

      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) { container.innerHTML = "User record not found."; return; }

      const recruiterOrg = snap.data().organisation_name;
      if (!recruiterOrg) { container.innerHTML = "No organisation linked to this recruiter."; return; }

      orgJobs = await getJobsByCompany(recruiterOrg);
      if (!orgJobs.length) { container.innerHTML = "No jobs found for your organisation."; return; }

      roleDropdown.innerHTML = `<option value="">Sorting by matches…</option>`;

      const matchCounts = await Promise.all(
        orgJobs.map(async j => {
          try {
            const { total_matches } = await getMatches({ job_id: j.job_id, top_n: 1, offset: 0 });
            return { job_id: j.job_id, count: total_matches };
          } catch { return { job_id: j.job_id, count: 0 }; }
        })
      );

      const countMap = {};
      matchCounts.forEach(m => { countMap[m.job_id] = m.count; });

      const sortedJobs = [...orgJobs].sort((a, b) => (countMap[b.job_id] || 0) - (countMap[a.job_id] || 0));

      roleDropdown.innerHTML = sortedJobs.map(j => {
        const loc = j.city || j.location || "";
        const count = countMap[j.job_id] || 0;
        const label = `${j.title}${loc ? ` — ${loc}` : ""} (${count} match${count !== 1 ? "es" : ""})`;
        return `<option value="${escAttr(j.job_id)}">${escHtml(label)}</option>`;
      }).join("");

      const defaultJobId = sortedJobs[0].job_id;
      roleDropdown.value = defaultJobId;

      window.triggerLoadCandidates();

      roleDropdown.addEventListener("change", () => window.triggerLoadCandidates());
    });
  }

  async function loadCandidatesForRole(jobId) {
    const container = $("candMatchesTable");
    const selectedJob = orgJobs.find(j => j.job_id === jobId);

    if (!selectedJob) { if (container) container.innerHTML = "No job found."; return; }
    selectedJobIdForCandidates = selectedJob.job_id;

    let matches;
    try {
      const res = await getMatches({ job_id: selectedJob.job_id, top_n: 50, offset: 0 });
      matches = res.matches;
    } catch {
      if (container) container.innerHTML = "Match service temporarily unavailable.";
      return;
    }

    if (!matches.length) {
      if (container) container.innerHTML = `
        <div class="empty-state">
          <h4>No candidates found</h4>
          <p>No matches for this job yet.</p>
        </div>`;
      return;
    }

    const enriched = await Promise.all(matches.map(async match => {
      try {
        const snap = await getDoc(doc(db, "candidates", match.candidate_id));
        const cd = snap.exists() ? snap.data() : {};
        return {
          ...match,
          name: cd.name || match.name || match.email || "",
          email: cd.email || match.email || "",
          resume_text: (cd.resume_text || "").slice(0, 600),
          applied_role: cd.applied_role || ""
        };
      } catch { return match; }
    }));

    allCandidates = enriched;
    currentLlmMap = {};

    window.renderCandidateCards(enriched, {});

    enrichCandidatesWithLLM(enriched, selectedJobIdForCandidates, selectedJob)
      .then(llmResults => {
        const llmMap = {};
        llmResults.forEach(r => { llmMap[r.candidate_id] = r; });
        currentLlmMap = llmMap;
        window.patchCandidateLlm(llmMap);
      })
      .catch(() => {});
  }

  initCandidateMatchesPage();


  /* ── Invite to Apply modal ── */
  let _inviteState = null;

  window.openInviteModal = async function (candidateId, name, email, jobId, jobTitle) {
    jobTitle = jobTitle || "Unknown Role";

    const user = auth.currentUser;
    if (!user) { showToast("Please log in first.", "warning"); return; }

    let recruiterName = "";
    try {
      const uSnap = await getDoc(doc(db, "users", user.uid));
      if (uSnap.exists()) {
        const u = uSnap.data();
        recruiterName = u.name || u.displayName || "A recruiter";
      }
    } catch { /* proceed without a name */ }

    _inviteState = { candidateId, name, email, jobId, jobTitle, recruiterId: user.uid, recruiterName };

    $("inviteModalName").textContent = name || "Candidate";
    $("inviteModalJob").textContent = `Inviting to apply for: ${jobTitle}`;
    $("inviteNoteInput").value = "";
    $("inviteStatusMsg").style.display = "none";

    const btn = $("inviteSubmitBtn");
    btn.disabled = false;
    btn.textContent = "📨 Send Invite";

    $("inviteOverlay").style.display = "flex";
  };

  window.closeInviteModal = function () {
    $("inviteOverlay").style.display = "none";
    _inviteState = null;
  };

  window.draftInviteWithAI = async function () {
    if (!_inviteState) return;
    const btn = $("inviteAiBtn");
    btn.disabled = true;
    btn.textContent = "✨ Drafting…";

    const prompt = `You are a recruiter at a company. Write a short, warm, professional 2-paragraph message inviting a candidate named ${_inviteState.name || "the candidate"} to apply for the role of "${_inviteState.jobTitle}". Be encouraging and specific about why they'd be a great fit. Return only the message body, no subject line.`;

    try {
      const draft = await callGemini(prompt, "draft_email");
      $("inviteNoteInput").value = draft.trim();
    } catch {
      showToast("AI draft failed. Try again.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ Draft with AI";
    }
  };

  window.submitInvite = async function () {
    if (!_inviteState) return;
    const { candidateId, jobId, jobTitle, recruiterId, recruiterName } = _inviteState;
    const email = _inviteState.email;
    const note = $("inviteNoteInput").value.trim();
    const btn = $("inviteSubmitBtn");
    const msg = $("inviteStatusMsg");

    btn.disabled = true;
    btn.textContent = "⏳ Sending…";
    msg.style.display = "none";

    let candidateUserUid = null;
    try {
      const cSnap = await getDoc(doc(db, "candidates", candidateId));
      candidateUserUid = cSnap.exists() ? (cSnap.data().user_id || null) : null;
    } catch { /* proceed without notification */ }

    // Deep-link to jobmatches.html so the Quick Apply modal opens there
    // directly, pre-filled, once the candidate clicks through.
    const applyUrl = `jobmatches.html?apply=${encodeURIComponent(jobId)}&title=${encodeURIComponent(jobTitle)}&recruiter=${encodeURIComponent(recruiterId)}`;

    try {
      if (candidateUserUid) {
        await addDoc(collection(db, "notifications"), {
          to_user_id: candidateUserUid,
          to_role: "candidate",
          from_role: "recruiter",
          from_user_id: recruiterId, // SEC-11: this is the signed-in uid (set in openInviteModal)
          candidate_id: candidateId, // SEC-11: lets the rules check the recipient owns this candidate
          type: "invite_to_apply",
          job_id: jobId,
          job_title: jobTitle,
          recruiter_id: recruiterId,
          recruiter_name: recruiterName,
          message: note || `${recruiterName || "A recruiter"} invited you to apply for "${jobTitle}".`,
          apply_url: applyUrl,
          read: false,
          created_at: serverTimestamp()
        });
      }

      const mailtoBase = safeMailto(email);
      if (mailtoBase) {
        const subject = encodeURIComponent(`You've been invited to apply — ${jobTitle}`);
        const body = encodeURIComponent(
          (note ? note + "\n\n" : "") +
          `Apply here: ${window.location.origin}/${applyUrl}\n\nBeyondMatch`
        );
        const a = document.createElement("a");
        a.href = `${mailtoBase}?subject=${subject}&body=${body}`;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      msg.textContent = candidateUserUid
        ? "✅ Invite sent! The candidate will see it in their notifications."
        : email
          ? "✅ Email invite sent to candidate."
          : "✅ Invite recorded (no email/account found for this candidate).";
      msg.style.cssText += ";background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.2);color:var(--green, #4ade80);display:block;";
      btn.textContent = "✓ Sent";

      setTimeout(() => window.closeInviteModal(), 2500);
    } catch (err) {
      logError("invite failed", err);
      msg.textContent = "Failed to send invite. Please try again.";
      msg.style.cssText += ";background:rgba(248,113,113,.07);border:1px solid rgba(248,113,113,.2);color:var(--red, #f87171);display:block;";
      btn.disabled = false;
      btn.textContent = "📨 Send Invite";
    }
  };


  /* ── Candidate profile modal (for API-matched candidates) ── */
  window.openCandProfile = async function (candidateId, name, email, jobId) {
    const overlay = $("candProfileOverlay");
    const content = $("candProfileContent");
    overlay.style.display = "flex";

    content.innerHTML = `
      <div style="font-size:11px;color:var(--blue, #7aa2ff);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;">Candidate Profile</div>
      <div style="display:flex;align-items:center;gap:10px;color:var(--text-3, #6b7280);font-size:13px;padding:24px 0;">
        <div style="width:18px;height:18px;border-radius:50%;border:2px solid var(--blue, #7aa2ff);border-top-color:transparent;animation:spin .8s linear infinite;flex-shrink:0;"></div>
        Loading profile…
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;

    let candData = null;
    try {
      const snap = await getDoc(doc(db, "candidates", candidateId));
      if (snap.exists()) candData = snap.data();
    } catch { /* use passed-in args as fallback */ }

    const displayName  = candData?.name  || name  || "Candidate";
    const displayEmail = candData?.email || email || "";
    const role         = candData?.applied_role || "";
    const skills       = (candData?.matched_skills || []).slice(0, 8);
    const resumeSnip   = (candData?.resume_text || "").slice(0, 500);

    const llm = currentLlmMap[candidateId] || {};
    const insight = llm.recruiter_summary || "";

    content.innerHTML = `
      <div style="font-size:11px;color:var(--blue, #7aa2ff);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Profile</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:var(--text-1, #e2e8f0);">${escHtml(displayName)}</h2>
      ${role ? `<p style="margin:0 0 20px;color:var(--text-3, #6b7fa8);font-size:13px;">${escHtml(role)}</p>` : '<div style="margin-bottom:20px;"></div>'}

      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        ${displayEmail ? `
          <div>
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted, #4a5580);margin-bottom:3px;">Email</div>
            <div style="font-size:13.5px;color:var(--text-2, #c9d5e8);">${escHtml(displayEmail)}</div>
          </div>` : ""}
        ${jobId ? `
          <div>
            <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted, #4a5580);margin-bottom:3px;">Matched For Job</div>
            <div style="font-size:13px;color:var(--text-2, #c9d5e8);font-family:monospace;">${escHtml(jobId)}</div>
          </div>` : ""}
      </div>

      ${skills.length ? `
        <div style="margin-bottom:18px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted, #4a5580);margin-bottom:8px;">Matched Skills</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;">
            ${skills.map(s => `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;background:rgba(122,162,255,0.12);color:var(--blue, #7aa2ff);border:1px solid rgba(122,162,255,0.2);text-transform:uppercase;letter-spacing:0.03em;">${escHtml(s)}</span>`).join("")}
          </div>
        </div>` : ""}

      ${insight ? `
        <div style="margin-bottom:18px;font-size:12px;color:var(--text-2, #9bb3ff);background:rgba(122,162,255,0.06);border:1px solid rgba(122,162,255,0.12);border-radius:7px;padding:9px 12px;line-height:1.55;">
          ✦ ${escHtml(insight)}
        </div>` : ""}

      ${resumeSnip ? `
        <div style="margin-bottom:20px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted, #4a5580);margin-bottom:8px;">Resume Snippet</div>
          <div style="background:var(--surface, #090e1c);border:1px solid rgba(122,162,255,0.1);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-2, #a0aec0);line-height:1.6;max-height:120px;overflow-y:auto;">
            ${escHtml(resumeSnip)}${(candData?.resume_text || "").length > 500 ? "…" : ""}
          </div>
        </div>` : ""}

      <div style="height:1px;background:rgba(122,162,255,0.08);margin-bottom:18px;"></div>

      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
        ${safeMailto(displayEmail, "Your profile on BeyondMatch") ? `
          <a href="${escAttr(safeMailto(displayEmail, "Your profile on BeyondMatch"))}" style="
            display:inline-flex;align-items:center;gap:6px;
            font-family:inherit;font-size:13px;font-weight:600;
            padding:9px 18px;border-radius:9px;cursor:pointer;
            border:1px solid rgba(122,162,255,0.2);
            background:transparent;color:var(--blue, #7aa2ff);
            text-decoration:none;transition:all .18s;
          ">
            ✉ Email Candidate
          </a>` : ""}
        <button data-candidate-id="${escAttr(candidateId)}" data-cand-name="${escAttr(displayName)}" data-job-id="${escAttr(jobId || "")}" onclick="
          document.getElementById('candProfileOverlay').style.display='none';
          window.openCandidateAnalysis && openCandidateAnalysis(this.dataset.candidateId, this.dataset.candName, this.dataset.jobId);
        " style="
          font-family:inherit;font-size:13px;font-weight:600;
          padding:9px 18px;border-radius:9px;cursor:pointer;
          border:1px solid rgba(192,132,252,0.25);
          background:rgba(192,132,252,0.08);color:var(--purple, #c084fc);
          transition:all .18s;
        ">
          🔍 Deep Analysis
        </button>
      </div>
    `;
  };
}


/* =========================================================
   ====================  JOBS.HTML  ======================
   Unified, tabbed view-only job feed covering every supported
   country region (UK/USA/UAE/India/Germany/France) in one page.
   Replaces the four near-duplicate ukjobs.html/usajobs.html/
   uaejobs.html/indiajobs.html pages+blocks (plus adds Germany
   and France) with a single config-driven implementation,
   switched via a country tab bar instead of separate pages.

   Each region tab is only fetched the first time it's opened
   (loadJobsForCountryProgressive, same progressive-render
   approach the original per-country blocks used) and then kept
   in memory for the rest of the session — including its own
   Remote/Others sub-tab, search, and sort state — so flipping
   between country tabs doesn't refetch or lose your place.

   FIX (accurate tab-pill counts on first load): previously
   loadCountryJobs() was only ever invoked for the active tab on
   page load, so every other tab's pill sat at "0" until you
   physically clicked it. loadCountryJobs() already called
   renderTabCount(key) on every batch regardless of which tab was
   active — it just was never triggered for the non-active tabs.
   The onAuthStateChanged handler below now kicks off a background
   load for every tab (active tab first, so the visible grid still
   appears fastest), so all six pills fill in as their region's
   pages come back instead of staying at 0 until clicked.

   FIX (no flicker on batch re-render): renderJobs() rebuilds the
   grid's innerHTML from scratch on every incoming page of a
   region's progressive load, and any CSS entrance animation on
   .job-modern-card (e.g. a fade/slide-in defined in
   recruiter-matches.css) was replaying on every single one of
   those rebuilds, producing a visible "refresh" flash. Each card
   now carries an inline `animation:none !important;` so no
   animation plays on (re)render, regardless of what's defined in
   the stylesheet.

   FIX (contact fetch not "sticking" + full-grid reload on fetch):
   openContactModal() previously only wrote fetched Apollo contacts
   into the session-only _contactCache, never onto the `job` object
   itself — and the 📇 badge is computed straight from job.contacts /
   job.contact_emails. So the moment ANYTHING re-rendered the grid
   (a tab switch, the background per-tab loads below, a new page of
   jobs streaming in), the badge read stale data off `job` and looked
   like the fetch had been lost. There was also no way to patch a
   single card, so the only "update" available was rebuilding the
   whole grid via renderJobs() — which is the "reload" that was
   visible. Fixed by: (1) tagging each card with data-job-id, (2)
   pulling the badge markup into getContactBadgeHTML() so both the
   bulk render and a single-card patch use identical logic, and (3)
   writing the fetched contacts back onto `job.contacts` in
   openContactModal() and patching just that one card in place via
   applyContactBadgeToCard() — no grid rebuild, no flicker.
========================================================= */
if ($("jobsGrid") && $("jobsPageTitle")) {
  const COUNTRY_TABS = {
    uk: {
      code: "GB", label: "UK", regionLabel: "United Kingdom", flag: "🇬🇧", locale: "en-GB",
      pageTitle: "UK Jobs", badgeText: "United Kingdom only",
      subtitle: "Every job on the platform located in the UK, split by Remote vs. on-site/hybrid"
    },
    usa: {
      code: "US", label: "USA", regionLabel: "United States", flag: "🇺🇸", locale: "en-US",
      pageTitle: "USA Jobs", badgeText: "United States only",
      subtitle: "Every job on the platform located in the USA, split by Remote vs. on-site/hybrid"
    },
    uae: {
      code: "AE", label: "UAE", regionLabel: "United Arab Emirates", flag: "🇦🇪", locale: "en-GB",
      pageTitle: "UAE Jobs", badgeText: "United Arab Emirates only",
      subtitle: "Every job on the platform located in the UAE, split by Remote vs. on-site/hybrid"
    },
    india: {
      code: "IN", label: "India", regionLabel: "India", flag: "🇮🇳", locale: "en-GB",
      pageTitle: "India Jobs", badgeText: "India only",
      subtitle: "Every job on the platform located in India, split by Remote vs. on-site/hybrid"
    },
    germany: {
      code: "DE", label: "Germany", regionLabel: "Germany", flag: "🇩🇪", locale: "en-GB",
      pageTitle: "Germany Jobs", badgeText: "Germany only",
      subtitle: "Every job on the platform located in Germany, split by Remote vs. on-site/hybrid"
    },
    france: {
      code: "FR", label: "France", regionLabel: "France", flag: "🇫🇷", locale: "en-GB",
      pageTitle: "France Jobs", badgeText: "France only",
      subtitle: "Every job on the platform located in France, split by Remote vs. on-site/hybrid"
    },
  };

  const grid = $("jobsGrid");
  const tabButtons = Array.from(document.querySelectorAll("#jobsCountryTabs .loc-tab"));

  // job_id -> job record, refreshed on every renderJobs() pass, so the
  // Contact modal can pull the full job (and real job.contacts once the
  // lambda supplies it) without stuffing JSON into an inline onclick attr.
  const _jobsById = {};

  // Session-only cache of fetched Apollo contacts, keyed by job_id, so
  // reopening the same job's modal within one session doesn't re-fetch
  // (the backend's own cache already protects Apollo credits either
  // way — this just avoids the extra ~1-2s round trip on a repeat
  // click).
  const _contactCache = {}; // job_id -> contacts array, this session only

  function skel() {
    return `
      <div class="job-card skeleton-card" aria-hidden="true">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-btn"></div>
      </div>`;
  }
  grid.innerHTML = Array(6).fill(null).map(skel).join("");

  // Per-country state, kept in memory for the whole session so tab
  // switches don't lose the current filter/sort selection or refetch
  // data that's already been loaded once.
  Object.values(COUNTRY_TABS).forEach(tab => {
    tab.jobs = [];
    tab.activeSubTab = "remote"; // "remote" | "others"
    tab.loadedOnce = false;
    tab.loading = false;
  });

  // Supports deep-linking / the old per-country pages (ukjobs.html etc,
  // now thin redirects) via ?country=usa and friends.
  const requestedCountry = new URLSearchParams(window.location.search).get("country");
  // SEC-14: own keys only, so ?country=constructor or __proto__ cannot select an inherited property.
  let activeCountry = Object.hasOwn(COUNTRY_TABS, requestedCountry) ? requestedCountry : "uk";

  function isRemoteJob(job) {
    return /\bREMOTE\b/i.test(getJobLocation(job) || "");
  }

  // getRegionLabel is expected to resolve each region's country tokens
  // (e.g. "GB"/"UK", "US"/"USA", "DE"/"Germany") to that region's
  // display label. Falls back to a direct country-code check in case
  // that mapping is ever missing, so a tab degrades gracefully rather
  // than silently showing 0 — same pattern the original per-country
  // blocks used.
  function isInRegion(job, tab) {
    const label = getRegionLabel(getJobLocation(job));
    if (label === tab.regionLabel) return true;
    const country = (job.country || "").trim().toUpperCase();
    return country === tab.code;
  }

  async function loadCountryJobs(key) {
    const tab = COUNTRY_TABS[key];
    if (tab.loading) return;
    tab.loading = true;
    await loadJobsForCountryProgressive(tab.code, (job) => isInRegion(job, tab), (partial) => {
      tab.jobs = partial;
      tab.loadedOnce = true;
      renderTabCount(key);
      if (activeCountry === key) {
        renderCounts();
        renderJobs();
      }
    });
    tab.loading = false;
  }

  function renderTabCount(key) {
    const el = $(`jobsCount-${key}`);
    if (el) el.textContent = COUNTRY_TABS[key].jobs.length;
  }

  function renderCounts() {
    const tab = COUNTRY_TABS[activeCountry];
    const remoteCount = tab.jobs.filter(isRemoteJob).length;
    const othersCount = tab.jobs.length - remoteCount;
    $("jobsRemoteCount").textContent = remoteCount;
    $("jobsOthersCount").textContent = othersCount;
    $("jobsTotalCount").textContent = tab.jobs.length;
  }

  // Shared by renderJobs() (initial card render) AND
  // applyContactBadgeToCard() (patching a single card after a live
  // Apollo fetch) — one source of truth for "does this job have a
  // storable contact" so the two paths can never disagree.
  function getContactBadgeHTML(job) {
    const contactEmails = [
      ...(Array.isArray(job.contact_emails) ? job.contact_emails : []),
      ...(job.contact_email ? [job.contact_email] : [])
    ].filter(v => typeof v === "string" && v.trim());

    const contactPhones = [
      ...(Array.isArray(job.contact_phones) ? job.contact_phones : []),
      ...(job.contact_phone ? [job.contact_phone] : [])
    ].filter(v => typeof v === "string" && v.trim());

    const arrayContacts = Array.isArray(job.contacts)
      ? job.contacts.filter(c =>
          c && (c.email || c.phone || c.contact_email || c.contact_phone)
        )
      : [];

    const hasContact =
      contactEmails.length > 0 ||
      contactPhones.length > 0 ||
      arrayContacts.length > 0;

    return hasContact
      ? `<span class="job-pill"
           style="
             background:rgba(74,222,128,.10);
             border-color:rgba(74,222,128,.28);
             color:var(--green, #4ade80);
           ">
           📇 Contact Available
         </span>`
      : "";
  }

  // Patches ONE card's badge row in place after a live contact fetch —
  // no grid rebuild, no flicker, no re-fetch of anything else. This is
  // the fix for "fetched correctly but wasn't stored/displayed, and
  // reloaded the whole page" — the fetch previously only ever landed in
  // _contactCache, never on `job` itself, and there was no way to patch
  // a single card, so the only "update" was a full renderJobs() rebuild.
  function applyContactBadgeToCard(jobId, job) {
    const card = document.querySelector(`.job-modern-card[data-job-id="${CSS.escape(jobId)}"]`);
    if (!card) return;
    const badgeRow = card.querySelector(".job-badge-row");
    if (!badgeRow) return;

    const locationPill = badgeRow.querySelector(".job-pill:first-child")?.outerHTML || "";
    badgeRow.innerHTML = `${locationPill}${getContactBadgeHTML(job)}`;
  }

  function renderJobs() {
    const tab = COUNTRY_TABS[activeCountry];
    let filtered = tab.jobs.filter(j => tab.activeSubTab === "remote" ? isRemoteJob(j) : !isRemoteJob(j));

    const searchTerm = $("jobsSearchInput")?.value.toLowerCase() || "";
    if (searchTerm) filtered = filtered.filter(j => (j.title || "").toLowerCase().includes(searchTerm));

    const sortValue = $("jobsSortSelect")?.value;
    if (sortValue === "newest") filtered.sort((a, b) => toSortableDate(b.created_at) - toSortableDate(a.created_at));
    else if (sortValue === "oldest") filtered.sort((a, b) => toSortableDate(a.created_at) - toSortableDate(b.created_at));
    else if (sortValue === "title") filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    if (!filtered.length) {
      grid.innerHTML = tab.loadedOnce
        ? `<p>No ${tab.activeSubTab === "remote" ? "remote" : "on-site/hybrid"} ${tab.label} jobs found.</p>`
        : "";
      return;
    }

    // NOTE: `style="animation:none !important;"` on the card is
    // deliberate — filtered/re-fetched batches replace this grid's
    // innerHTML wholesale on every incoming page, and without this the
    // stylesheet's card entrance animation (fade/slide-in) would replay
    // on every single re-render, producing a visible "refresh" flicker
    // as more results stream in. This keeps the grid updating silently.
    grid.innerHTML = filtered.map(job => {
      const rawDesc = (job.description || job.jd || "").replace(/<[^>]*>/g, "").trim();
      const descHTML = rawDesc
        ? `<p class="job-modern-desc">${escHtml(rawDesc.slice(0, 130))}${rawDesc.length > 130 ? "…" : ""}</p>`
        : "";
      const applyBtn = safeUrl(job.apply_url)
        ? `<a class="modern-view-btn" href="${escAttr(safeUrl(job.apply_url))}" target="_blank" rel="noopener noreferrer">View Job</a>`
        : "";
      const matchesHref = `cand-matches.html?job=${encodeURIComponent(job.job_id)}`;

      const contactBadge = getContactBadgeHTML(job);

      /* Store complete job for contact modal */
      _jobsById[job.job_id] = job;

      return `
      <div class="job-modern-card" data-job-id="${escAttr(job.job_id)}" style="animation:none !important;">
        <div class="job-modern-header"><h3>${escHtml(job.title)}</h3></div>
        <div class="job-badge-row" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
  <span class="job-pill">
    ${escHtml(isRemoteJob(job)
      ? tab.flag + " Remote"
      : "📍 " + (getJobLocation(job) || tab.label))}
  </span>

  ${contactBadge}
</div>
        <div class="job-modern-company">${escHtml(job.company || "-")}</div>
        <div class="job-modern-salary">${escHtml(formatSalary(job))}</div>
        ${descHTML}
        <div class="job-modern-actions">
          <a class="modern-view-btn" href="${escAttr(matchesHref)}">View Matches</a>
          ${applyBtn}
          <button type="button" class="modern-view-btn contact-btn" onclick="openContactModal(this.closest('.job-modern-card').dataset.jobId)">📇 Contact</button>
        </div>
      </div>`;
    }).join("");
  }

  /* =========================================================
     CONTACT DETAILS MODAL
     ---------------------------------------------------------
     Contacts are fetched on demand from the Apollo-backed
     contact-enrichment Lambda (see api.js's getCompanyContacts)
     the first time a recruiter opens a given job's Contact modal.
     Results are cached for the rest of this session in
     _contactCache AND written back onto the job object itself
     (see openContactModal below) so the 📇 badge reflects it
     immediately and survives any later re-render of the grid.
  ========================================================= */
  (function injectContactModal() {
    const style = document.createElement("style");
    style.textContent = `
      #bmContactOverlay {
        display:none; position:fixed; inset:0; background:rgba(0,0,0,0.78);
        backdrop-filter:blur(6px); z-index:1000; align-items:center; justify-content:center;
        padding:20px; box-sizing:border-box;
      }
      #bmContactOverlay.open { display:flex; }
      #bmContactModal {
        background:var(--surface, #0f1220); border:1px solid rgba(122,162,255,0.15);
        border-radius:16px; width:100%; max-width:560px; max-height:88vh; overflow-y:auto;
        padding:28px; box-sizing:border-box; position:relative; color:var(--text-1, #e2e8f0);
        animation: bmContactFadeIn .22s ease both;
      }
      @keyframes bmContactFadeIn { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
      .bm-contact-close {
        position:absolute; top:14px; right:16px; background:none; border:none;
        color:var(--text-muted, #4a5580); font-size:20px; cursor:pointer; line-height:1; transition:color .15s;
      }
      .bm-contact-close:hover { color:var(--text-1, #e2e8f0); }
      .bm-contact-label { font-size:11px; color:var(--blue, #7aa2ff); font-weight:700; letter-spacing:1px; text-transform:uppercase; }
      .bm-contact-placeholder-banner {
        margin-top:14px; padding:9px 12px; border-radius:10px; font-size:11.5px; line-height:1.5;
        background:rgba(251,191,36,0.08); border:1px solid rgba(251,191,36,0.25); color:var(--amber, #fbbf24);
        display:flex; align-items:flex-start; gap:7px;
      }
      .bm-contact-list { margin-top:16px; display:flex; flex-direction:column; gap:10px; }
      .bm-contact-card {
        background:var(--card, #131726); border:1px solid var(--card-border, rgba(122,162,255,.1));
        border-radius:12px; padding:14px 16px; display:flex; gap:12px; align-items:flex-start;
      }
      .bm-contact-avatar {
        width:38px; height:38px; border-radius:50%; flex-shrink:0; display:flex; align-items:center;
        justify-content:center; font-size:13px; font-weight:700; color:#080c18;
        background:linear-gradient(135deg, var(--blue, #7aa2ff), var(--purple, #c084fc));
      }
      .bm-contact-body { flex:1; min-width:0; }
      .bm-contact-row-top { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
      .bm-contact-name { font-size:13.5px; font-weight:600; color:var(--text-1, #e2e8f0); }
      .bm-contact-score {
        font-size:11px; font-weight:800; padding:2px 8px; border-radius:20px; white-space:nowrap;
      }
      .bm-contact-type-pill {
        display:inline-block; margin-top:3px; font-size:10.5px; font-weight:600; padding:2px 8px;
        border-radius:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08);
        color:var(--text-3, #6b7fa8);
      }
      .bm-contact-detail-row {
        display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12.5px; color:var(--text-2, #a0aec0);
      }
      .bm-contact-detail-row svg { flex-shrink:0; color:var(--text-3, #6b7fa8); }
      .bm-contact-detail-row span.val { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .bm-contact-copy-btn {
        margin-left:auto; flex-shrink:0; background:none; border:1px solid rgba(122,162,255,.2);
        color:var(--blue, #7aa2ff); border-radius:6px; font-size:10.5px; font-weight:600; font-family:inherit;
        padding:3px 9px; cursor:pointer; transition:all .15s;
      }
      .bm-contact-copy-btn:hover { background:rgba(122,162,255,.12); }
      .bm-contact-empty { padding:24px 4px; text-align:center; color:var(--text-3, #6b7fa8); font-size:13px; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "bmContactOverlay";
    overlay.innerHTML = `
      <div id="bmContactModal">
        <button class="bm-contact-close" id="bmContactClose">✕</button>
        <span class="bm-contact-label">Contact Details</span>
        <h2 id="bmContactJobTitle" style="margin:6px 0 0;font-size:19px;color:var(--text-1, #e2e8f0);"></h2>
        <p id="bmContactCompany" style="margin:2px 0 0;font-size:13px;color:var(--text-3, #6b7fa8);"></p>
        <div id="bmContactBanner"></div>
        <div id="bmContactList" class="bm-contact-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });
    $("bmContactClose").addEventListener("click", () => overlay.classList.remove("open"));
  })();

  function contactInitials(name) {
    return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  }

  window.openContactModal = async function (jobId) {
    const overlay = $("bmContactOverlay");
    if (!overlay) return;

    const job = _jobsById[jobId] || {};
    $("bmContactJobTitle").textContent = job.title || "Job";
    $("bmContactCompany").textContent = job.company || "";
    $("bmContactBanner").innerHTML = "";
    overlay.classList.add("open");

    // Session cache hit — render immediately, no network call.
    if (_contactCache[jobId]) {
      renderContactList(_contactCache[jobId]);
      return;
    }

    $("bmContactList").innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:24px 4px;color:var(--text-3, #6b7280);font-size:13px;">
        <div style="width:16px;height:16px;border-radius:50%;border:2px solid var(--blue, #7aa2ff);border-top-color:transparent;animation:bmContactSpin .8s linear infinite;flex-shrink:0;"></div>
        Looking up hiring contacts…
      </div>
      <style>@keyframes bmContactSpin{to{transform:rotate(360deg)}}</style>
    `;

    if (!job.company) {
      $("bmContactList").innerHTML = `<div class="bm-contact-empty">This job has no company name on record — can't look up contacts.</div>`;
      return;
    }

    try {
      const result = await getCompanyContacts({
        company: job.company,
        jobId: job.job_id,
        domain: job.company_domain || null,
      });

      if (result.error) {
        const detail = result.error.detail || result.error.step || "Lookup failed";
        $("bmContactList").innerHTML = `<div class="bm-contact-empty">${escHtml(String(detail))}</div>`;
        return;
      }

      if (!result.matched) {
        $("bmContactList").innerHTML = `<div class="bm-contact-empty">No matching company found for "${escHtml(job.company)}".</div>`;
        return;
      }

      const domain = (result.organization || {}).domain || "";
      const contacts = (result.contacts || []).map(c => ({
        name: c.name || c.title || "Hiring Contact",
        title: c.title || "",
        email: c.email || "",
        linkedin_url: c.linkedin_url || "",
        domain,
      }));

      _contactCache[jobId] = contacts;
      renderContactList(contacts);

      // Persist onto the job object itself, not just the session-only
      // _contactCache — this is what actually makes "Contact Available"
      // show up, and makes it survive any re-render. The Lambda backend
      // also writes this back to DynamoDB via job_id, so a real page
      // reload will pick it up too, without spending another Apollo
      // credit on the same company.
      job.contacts = contacts;
      job.company_domain = job.company_domain || domain;
      applyContactBadgeToCard(jobId, job);
    } catch (err) {
      $("bmContactList").innerHTML = `
        <div class="bm-contact-empty">
          Couldn't reach the contact lookup service.
        </div>`;
      logError("contact lookup failed", err);
    }
  };

  // Renders the contact list into the already-open modal. Split out from
  // openContactModal so the session-cache hit path and the live-fetch
  // path share identical rendering.
  function renderContactList(contacts) {
    if (!contacts.length) {
      $("bmContactList").innerHTML = `<div class="bm-contact-empty">No hiring contacts found for this company.</div>`;
      return;
    }

    $("bmContactList").innerHTML = contacts.map(c => {
      const emailRow = c.email ? `
        <div class="bm-contact-detail-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
          <span class="val">${escHtml(c.email)}</span>
          <button type="button" class="bm-contact-copy-btn" data-email="${escAttr(c.email)}" onclick="navigator.clipboard.writeText(this.dataset.email).then(()=>showToast('Email copied','success'))">Copy</button>
        </div>` : `
        <div class="bm-contact-detail-row" style="color:var(--text-3, #6b7fa8);font-style:italic;">
          No email revealed for this contact
        </div>`;

      const linkedinRow = safeUrl(c.linkedin_url) ? `
        <div class="bm-contact-detail-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>
          <a class="val" href="${escAttr(safeUrl(c.linkedin_url))}" target="_blank" rel="noopener" style="color:var(--blue, #7aa2ff);text-decoration:none;">View LinkedIn</a>
        </div>` : "";

      const domainRow = c.domain ? `
        <div class="bm-contact-detail-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>
          <span class="val">${escHtml(c.domain)}</span>
        </div>` : "";

      return `
      <div class="bm-contact-card">
        <div class="bm-contact-avatar">${escHtml(contactInitials(c.name))}</div>
        <div class="bm-contact-body">
          <div class="bm-contact-row-top">
            <span class="bm-contact-name">${escHtml(c.name)}</span>
          </div>
          ${c.title ? `<span class="bm-contact-type-pill">${escHtml(c.title)}</span>` : ""}
          ${emailRow}
          ${linkedinRow}
          ${domainRow}
        </div>
      </div>`;
    }).join("");
  }

  // Builds the same filtered/searched/sorted list currently on screen
  // (country tab + remote-vs-others tab + search box + sort dropdown)
  // so what gets exported always matches what the recruiter is looking at.
  function getVisibleJobs() {
    const tab = COUNTRY_TABS[activeCountry];
    let filtered = tab.jobs.filter(j => tab.activeSubTab === "remote" ? isRemoteJob(j) : !isRemoteJob(j));

    const searchTerm = $("jobsSearchInput")?.value.toLowerCase() || "";
    if (searchTerm) filtered = filtered.filter(j => (j.title || "").toLowerCase().includes(searchTerm));

    const sortValue = $("jobsSortSelect")?.value;
    if (sortValue === "newest") filtered.sort((a, b) => toSortableDate(b.created_at) - toSortableDate(a.created_at));
    else if (sortValue === "oldest") filtered.sort((a, b) => toSortableDate(a.created_at) - toSortableDate(b.created_at));
    else if (sortValue === "title") filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    return filtered;
  }

  function exportJobsToExcel() {
    if (typeof XLSX === "undefined") {
      showToast("Export library didn't load — refresh the page and try again.", "error");
      return;
    }

    const tab = COUNTRY_TABS[activeCountry];
    const rows = getVisibleJobs();

    if (!rows.length) {
      showToast("No jobs in this view to export.", "warning");
      return;
    }

    const sheetData = rows.map(job => ({
      "Job Title":   job.title || "",
      "Company":     job.company || "",
      "Location":    getJobLocation(job) || "-",
      "Work Type":   isRemoteJob(job) ? "Remote" : "On-site/Hybrid",
      "Salary":      formatSalary(job),
      "Source":      job.source || "",
      "Posted":      job.created_at ? new Date(job.created_at).toLocaleDateString(tab.locale) : "",
      "Apply Link":  job.apply_url || ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(sheetData);

    // Sensible fixed column widths so the file doesn't open looking cramped.
    worksheet["!cols"] = [
      { wch: 38 }, // Job Title
      { wch: 26 }, // Company
      { wch: 28 }, // Location
      { wch: 16 }, // Work Type
      { wch: 20 }, // Salary
      { wch: 12 }, // Source
      { wch: 12 }, // Posted
      { wch: 48 }  // Apply Link
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `${tab.label} Jobs`);

    const dateStamp = new Date().toISOString().slice(0, 10);
    const subTabLabel = tab.activeSubTab === "remote" ? "remote" : "onsite";

    XLSX.writeFile(workbook, `beyondmatch-${activeCountry}-jobs-${subTabLabel}-${dateStamp}.xlsx`);
  }

  function updateHeader() {
    const tab = COUNTRY_TABS[activeCountry];
    $("jobsPageTitle").innerHTML = `${tab.pageTitle} <span class="uk-flag-badge" id="jobsFlagBadge">${tab.flag} ${tab.badgeText}</span>`;
    const pageSubtitle = $("jobsPageSubtitle");
    if (pageSubtitle) pageSubtitle.textContent = tab.subtitle;
    $("jobsRemoteLabel").innerHTML = `${tab.flag} Remote: <strong id="jobsRemoteCount" style="color:#7aa2ff;">0</strong>`;
    $("jobsTotalLabel").textContent = tab.label;
  }

  function switchSubTab(sub) {
    const tab = COUNTRY_TABS[activeCountry];
    tab.activeSubTab = sub;
    $("jobsRemoteBtn").classList.toggle("active", sub === "remote");
    $("jobsRemoteBtn").classList.toggle("secondary", sub !== "remote");
    $("jobsOthersBtn").classList.toggle("active", sub === "others");
    $("jobsOthersBtn").classList.toggle("secondary", sub !== "others");
    renderJobs();
  }

  function switchCountry(key) {
    if (!COUNTRY_TABS[key]) return;
    activeCountry = key;
    tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.country === key));

    const tab = COUNTRY_TABS[key];
    updateHeader();

    $("jobsSearchInput").value = "";
    $("jobsSortSelect").value = "newest";
    tab.activeSubTab = "remote";
    $("jobsRemoteBtn").classList.add("active");
    $("jobsRemoteBtn").classList.remove("secondary");
    $("jobsOthersBtn").classList.remove("active");
    $("jobsOthersBtn").classList.add("secondary");

    if (!tab.loadedOnce) grid.innerHTML = Array(6).fill(null).map(skel).join("");
    renderCounts();
    renderJobs();

    if (!tab.loadedOnce && !tab.loading) loadCountryJobs(key);
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => switchCountry(btn.dataset.country));
  });

  $("jobsRemoteBtn")?.addEventListener("click", () => switchSubTab("remote"));
  $("jobsOthersBtn")?.addEventListener("click", () => switchSubTab("others"));
  $("jobsSearchInput")?.addEventListener("input", renderJobs);
  $("jobsSortSelect")?.addEventListener("change", renderJobs);
  $("jobsExportBtn")?.addEventListener("click", exportJobsToExcel);

  tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.country === activeCountry));
  updateHeader();

  onAuthStateChanged(auth, (user) => {
    if (!user) return;

    // Load the currently active tab first so the visible grid appears
    // as fast as possible.
    loadCountryJobs(activeCountry);

    // Then background-load every other tab too, purely so their pill
    // counts (#jobsCount-<key>) are accurate on first visit instead of
    // sitting at 0 until the recruiter actually clicks that tab. This
    // never touches the visible grid for non-active tabs — renderJobs()/
    // renderCounts() above are gated behind `activeCountry === key`.
    Object.keys(COUNTRY_TABS)
      .filter(key => key !== activeCountry)
      .forEach(key => loadCountryJobs(key));
  });
}