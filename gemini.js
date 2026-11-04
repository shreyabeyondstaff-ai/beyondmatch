/* =========================================================
   GEMINI.JS  —  LLM client wrapper
   Kept named "callGemini" for backward compatibility with the
   feature key contract below. The only change from the
   original version is that the network call itself now goes
   through api.js's callLLM() instead of calling fetch() here —
   api.js is the only file allowed to do that.

   PER-FEATURE ROUTING (decided server-side)
   ─────────────────────────────────────────
   Pass an optional feature key as the second argument. It is sent
   to the Lambda as `feature`; the Lambda alone maps it to a
   provider (SEC-08: the browser never names a provider or model,
   and the Lambda must ignore any such field). Intended mapping,
   which now lives in the backend:

   "recommendations"    → groq         candidate.js  enrichMatchesWithLLM()
   "know_more"          → groq         candidate.js  openKnowMoreModal()
   "rec_summaries"      → groq         recruiter.js  enrichCandidatesWithLLM()
   "candidate_analysis" → groq         recruiter.js  openCandidateAnalysis()
   "draft_email"        → openrouter   recruiter.js  aiDraftBtn handler
   "resume_analysis"    → openrouter   candidate.js  runAnalysis()
   "jd_parse"           → openrouter   recruiter.js  aiParse()
   "cover_letter"       → openrouter   (future)
   "admin_analysis"     → (any)        admin.js      runAIAnalysis()  (admin role only)
   (omitted / unknown)  → Lambda picks first available (or rejects)

   CALL SIGNATURES
   ───────────────
   const text = await callGemini(prompt);
   const text = await callGemini(prompt, "draft_email");
========================================================= */

import { callLLM } from "./api.js";

// Feature labels the app may send. Anything else is dropped client-side and
// would be ignored by the backend anyway.
const KNOWN_FEATURES = new Set([
  "recommendations", "know_more", "rec_summaries", "candidate_analysis",
  "draft_email", "resume_analysis", "cover_letter", "jd_parse", "admin_analysis"
]);

/* ─── In-memory prompt cache ─────────────────────────────
   Cache key includes feature so the same prompt sent via
   different features never collides. Cleared on page reload.
   ──────────────────────────────────────────────────────── */
const _promptCache = new Map();

function _hashPrompt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * Send a prompt to the LLM endpoint.
 * Retries once after 2s on failure. Results are cached in-memory.
 *
 * @param {string} prompt        — The full prompt text.
 * @param {string} [feature=""]  — Optional feature key from KNOWN_FEATURES.
 * @returns {Promise<string>}    — Raw text response, or "" on failure.
 */
export async function callGemini(prompt, feature = "") {
  const featureLabel = KNOWN_FEATURES.has(feature) ? feature : "";
  const cacheKey = _hashPrompt(feature + "|" + prompt);

  if (_promptCache.has(cacheKey)) return _promptCache.get(cacheKey);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callLLM(prompt, featureLabel);
      if (result) _promptCache.set(cacheKey, result);
      return result;
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return "";
}

export function isGeminiAvailable() {
  return true;
}
