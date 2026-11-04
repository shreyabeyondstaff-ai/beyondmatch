/* =========================================================
   API.JS
   The ONLY file in the project allowed to make network requests. Every
   other module gets data through the typed functions exported
   here. Firestore reads/writes are a separate SDK and stay in
   each feature module (auth.js/candidate.js/recruiter.js/
   admin.js/settings.js) — this file only covers our own REST
   backend, the LLM proxy, and the third-party geocoding APIs.
========================================================= */

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { auth, API_BASE, LLM_ENDPOINT, EMBED_URL_ENDPOINT } from "./config.js";

/* =========================================================
   AUTHENTICATED FETCH (SEC-02)
   Every call to our own backend (API Gateway) goes through
   this wrapper, which attaches the signed-in Firebase user's
   ID token as `Authorization: Bearer <token>`. The identity
   comes from the Firebase SDK session, never from a UID/email
   the caller supplies. With no signed-in user it throws and
   sends NOTHING, so a protected route is never called
   anonymously. Third-party calls (geocoding) deliberately use
   the browser's native fetch so the token is never sent off-site.
========================================================= */
async function _currentUser() {
  if (auth.currentUser) return auth.currentUser;
  // Page just loaded: wait for Firebase to restore the session.
  return new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, u => { unsub(); resolve(u); });
  });
}

async function authedFetch(url, options = {}) {
  const user = await _currentUser();
  if (!user) throw new Error("Not authenticated");
  const send = async forceRefresh => {
    const token = await user.getIdToken(forceRefresh);
    return fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` }
    });
  };
  const res = await send(false);
  // Once the backend enforces tokens, a 401 can mean the cached token just
  // expired or its claims changed: retry once with a freshly minted token.
  return res.status === 401 ? send(true) : res;
}

/* =========================================================
   GENERIC FETCH
   Handles AWS Lambda's {statusCode, body} envelope automatically.
========================================================= */
export async function apiFetch(path, options = {}, { throwOnError = false } = {}) {
  const res = await authedFetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });

  if (!res.ok) {
    if (throwOnError) throw new Error(`HTTP ${res.status} ${path}`);
    return {};
  }

  const text = await res.text();

  if (!text) return {};

  const data = JSON.parse(text);

  if (data.statusCode && data.body && typeof data.body === "string") {
    try {
      return JSON.parse(data.body);
    } catch {
      return data.body;
    }
  }

  return data;
}

/* =========================================================
   RESPONSE NORMALISATION
========================================================= */
export function normalizeApiResponse(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;

  if (res.body && typeof res.body === "string") {
    try {
      const parsed = JSON.parse(res.body);

      if (Array.isArray(parsed)) return parsed;
      if (parsed.jobs) return parsed.jobs;
      if (parsed.matches) return parsed.matches;

      return [];
    } catch {
      return [];
    }
  }

  if (res.jobs) return res.jobs;
  if (res.matches) return res.matches;

  return [];
}

/* =========================================================
   JOBS
========================================================= */

const SUPPORTED_JOB_COUNTRIES = new Set([
  "GB",
  "US",
  "AE",
  "IN",
  "DE",
  "FR"
]);

function _isSupportedJobCountry(country) {
  return SUPPORTED_JOB_COUNTRIES.has(
    (country || "").trim().toUpperCase()
  );
}

/*
 * Default /jobs request.
 *
 * IMPORTANT:
 * The frontend still applies the six-country safety filter here,
 * but the backend is also responsible for enforcing the same rule.
 */
export async function getJobs() {
  const res = await apiFetch("/jobs");
  const jobs = normalizeApiResponse(res);

  return jobs.filter(
    j =>
      j?.is_active === true &&
      _isSupportedJobCountry(j?.country)
  );
}

/*
 * Single cached copy so multiple page sections share one request.
 */
let _cachedJobs = null;

export async function getStableJobs() {
  if (!_cachedJobs) {
    _cachedJobs = await getJobs();
  }

  return _cachedJobs;
}

/* =========================================================
   CONTACT ENRICHMENT (Apollo, on-demand per job)
========================================================= */

// Local dev only — local_contact_server.py serves this. Once this moves
// to the Lambda pipeline, change this single line to
// `${API_BASE}/contacts` and everything else below keeps working
// unchanged, since the response shape is designed to match either way.

/**
 * Fetches hiring contacts for ONE job's company, on demand — call this
 * only when the user clicks "Fetch Contact" for that specific job, not
 * in bulk. Apollo bills per company looked up, so this is deliberately
 * NOT called automatically for every job in a list.
 *
 * @param {{company: string, jobId?: string, domain?: string}} params
 * @returns {Promise<{
 *   job_id: string|null, matched: boolean, cached: boolean,
 *   organization: object|null,
 *   contacts: Array<{name: string|null, title: string, email: string|null, linkedin_url: string|null}>,
 *   error: object|null
 * }>}
 */
export async function getCompanyContacts({ company, jobId, domain } = {}) {
  if (!company && !domain) {
    throw new Error("getCompanyContacts requires at least a company name or a domain");
  }

  const qs = new URLSearchParams();
  if (company) qs.set("company", company);
  if (jobId) qs.set("job_id", jobId);
  if (domain) qs.set("domain", domain);

    const res = await authedFetch(`${API_BASE}/contacts?${qs.toString()}`);
  let body = {};
  try {
    body = await res.json();
  } catch {
    // fall through with body = {}
  }

  if (!res.ok) {
    const detail = body?.error?.detail || body?.error || `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  return body;
}

/* =========================================================
   JOBS BY COMPANY
========================================================= */

const _jobsByCompanyCache = {};

function _normaliseCompany(s) {
  return (s || "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function getJobsByCompany(company) {
  const cacheKey = _normaliseCompany(company);

  if (_jobsByCompanyCache[cacheKey]) {
    return _jobsByCompanyCache[cacheKey];
  }

  const res = await apiFetch(
    `/jobs?company=${encodeURIComponent(company)}`
  );

  let jobs = normalizeApiResponse(res).filter(
    j =>
      j?.is_active === true &&
      _isSupportedJobCountry(j?.country)
  );

  /*
   * Fallback:
   * Some backend deployments may not support ?company= filtering.
   * If nothing is returned, pull the supported jobs and filter locally.
   */
  if (!jobs.length) {
    const all = await getJobs();

    jobs = all.filter(
      j => _normaliseCompany(j.company) === cacheKey
    );
  }

  _jobsByCompanyCache[cacheKey] = jobs;

  return jobs;
}

/* =========================================================
   COUNTRY-SCOPED JOB LOOKUP
========================================================= */

/*
 * Country-scoped job lookup for the UK/USA/UAE/India/Germany/France
 * region pages.
 *
 * The backend uses the country-index GSI and returns paginated data.
 *
 * IMPORTANT COUNTRY-MISMATCH FIX:
 *
 * Previously the frontend only checked:
 *
 *     country is one of GB/US/AE/IN/DE/FR
 *
 * That was not enough.
 *
 * Example:
 *
 *     Requested country = US
 *     Backend accidentally returns country = AE
 *
 * AE is a supported country, so the old frontend accepted the job.
 *
 * The frontend now additionally requires:
 *
 *     returned country === requested country
 *
 * This is a second defensive layer on top of the backend fix.
 *
 * PROGRESSIVE RENDERING:
 * The Lambda returns a maximum of 1200 jobs per request plus
 * next_key. Each page is rendered as soon as it arrives.
 *
 * SESSION CACHE:
 * Completed country results are cached in sessionStorage.
 *
 * CACHE VERSION:
 * v3 intentionally invalidates the previous v2 cache because
 * v2 may contain jobs cached before the country-mismatch fix.
 */

const _JOBS_BY_COUNTRY_LIMIT = 1200;

function _countryCacheKey(countryCode) {
  return `bm_jobs_by_country_v3_${countryCode
    .trim()
    .toUpperCase()}`;
}

export async function getJobsByCountry(
  countryCode,
  { onPage, forceRefresh = false } = {}
) {
  const normalizedCountry = (countryCode || "")
    .trim()
    .toUpperCase();

  /*
   * Never make a request for an unsupported country.
   */
  if (!_isSupportedJobCountry(normalizedCountry)) {
    console.warn(
      "Unsupported jobs country code."
    );

    return [];
  }

  const cacheKey = _countryCacheKey(normalizedCountry);

  /*
   * Use the v3 cache only when explicitly allowed.
   *
   * v3 is intentional:
   * old v2 cache entries are ignored.
   */
  if (!forceRefresh) {
    try {
      const cached = sessionStorage.getItem(cacheKey);

      if (cached) {
        const parsed = JSON.parse(cached);

        if (Array.isArray(parsed) && parsed.length) {
          /*
           * Even cached data gets validated again.
           * This protects against corrupted/stale cache data.
           */
          const validatedCachedJobs = parsed.filter(
            j =>
              j?.is_active === true &&
              _isSupportedJobCountry(j?.country) &&
              String(j?.country || "")
                .trim()
                .toUpperCase() === normalizedCountry
          );

          onPage?.(
            validatedCachedJobs,
            validatedCachedJobs.length
          );

          return validatedCachedJobs;
        }
      }
    } catch {
      /*
       * Corrupt cache entry:
       * ignore it and fetch fresh data.
       */
    }
  }

  const allJobs = [];

  let lastKey = null;
  let guard = 0;

  /*
   * Paginate until the backend has no next_key.
   */
  do {
    const qs = new URLSearchParams({
      country: normalizedCountry,
      limit: String(_JOBS_BY_COUNTRY_LIMIT)
    });

    if (lastKey) {
      qs.set("last_key", lastKey);
    }

    const res = await apiFetch(
      `/jobs?${qs.toString()}`
    );

    /*
     * Expected backend response:
     *
     * {
     *   jobs: [...],
     *   next_key: "..."
     * }
     *
     * normalizeApiResponse() remains as a fallback for older
     * deployments returning a bare array.
     */
    const rawPageJobs = Array.isArray(res?.jobs)
      ? res.jobs
      : normalizeApiResponse(res);

    /*
     * =========================================================
     * COUNTRY MISMATCH FIX
     * =========================================================
     *
     * A job must satisfy ALL THREE:
     *
     * 1. Active
     * 2. Supported country
     * 3. EXACTLY the country requested by this page
     *
     * Example:
     *
     * UK page:
     *     requested = GB
     *
     * Job:
     *     country = US
     *
     * Result:
     *     REJECTED
     */
    const pageJobs = rawPageJobs.filter(
      j =>
        j?.is_active === true &&
        _isSupportedJobCountry(j?.country) &&
        String(j?.country || "")
          .trim()
          .toUpperCase() === normalizedCountry
    );

    allJobs.push(...pageJobs);

    /*
     * Progressive rendering.
     */
    if (pageJobs.length) {
      onPage?.(
        pageJobs,
        allJobs.length
      );
    }

    lastKey = res?.next_key || null;

    guard++;

    /*
     * Safety protection against a broken backend repeatedly
     * returning next_key with no usable jobs.
     */
    if (!pageJobs.length) {
      break;
    }

  } while (
    lastKey &&
    guard < 100
  );

  /*
   * Store ONLY already validated jobs.
   */
  try {
    sessionStorage.setItem(
      cacheKey,
      JSON.stringify(allJobs)
    );
  } catch {
    /*
     * Storage full/unavailable.
     * Not fatal — data is still returned.
     */
  }

  return allJobs;
}

/* =========================================================
   POST JOB
========================================================= */

export async function postJob(payload) {
  let data = {};

  const res = await authedFetch(
    `${API_BASE}/jobs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  try {
    const t = await res.text();
    data = t ? JSON.parse(t) : {};
  } catch {
    /* leave data as {} */
  }

  if (
    data.body &&
    typeof data.body === "string"
  ) {
    try {
      data = JSON.parse(data.body);
    } catch {
      /* leave as-is */
    }
  }

  if (!res.ok) {
    throw new Error(
      data.message ||
      data.error ||
      `HTTP ${res.status}`
    );
  }

  return data;
}

/* =========================================================
   ID VALIDATION (SEC-14)
   Job, candidate and recruiter ids reach requests, Firestore paths and
   DOM selectors, sometimes from a URL or the DOM. Real ids are
   64-character hashes, UUIDs, integers, or "local_<uid>_<time>", so
   anything outside letters, digits and _ . : - (or longer than 128) is
   rejected instead of being passed on.
========================================================= */
const _SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isSafeId(value) {
  return (typeof value === "string" || typeof value === "number")
    && _SAFE_ID.test(String(value));
}

/* =========================================================
   MATCHES
========================================================= */

export async function getMatches({
  job_id,
  candidate_id,
  top_n = 50,
  offset = 0
} = {}) {
  // Exactly one validated id, and numeric paging clamped to sane bounds.
  // Built with URLSearchParams so a value can never add or change a parameter.
  const qs = new URLSearchParams();
  const id = job_id ? job_id : candidate_id;
  if (!isSafeId(id)) {
    return { matches: [], total_matches: 0 };
  }
  qs.set(job_id ? "job_id" : "candidate_id", String(id));

  const n = Number.parseInt(top_n, 10);
  const o = Number.parseInt(offset, 10);
  qs.set("top_n", String(Number.isInteger(n) ? Math.min(Math.max(n, 1), 200) : 50));
  qs.set("offset", String(Number.isInteger(o) ? Math.min(Math.max(o, 0), 100000) : 0));

  const res = await apiFetch(
    `/matches?${qs.toString()}`
  );

  const data =
    typeof res?.body === "string"
      ? JSON.parse(res.body)
      : res;

  const matches = Array.isArray(data)
    ? data
    : (data?.matches || []);

  const total_matches =
    data?.total_matches ?? matches.length;

  return {
    matches,
    total_matches
  };
}

/* =========================================================
   CANDIDATES
========================================================= */

export async function registerCandidate(
  { name, email, resume_text },
  timeoutMs = 5000
) {
  try {
    const controller =
      new AbortController();

    const timeoutId = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    const res = await authedFetch(
      `${API_BASE}/candidates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          name,
          email,
          resume_text
        })
      }
    );

    clearTimeout(timeoutId);

    let data = {};

    try {
      data = JSON.parse(
        await res.text()
      );
    } catch {
      /* leave data as {} */
    }

    return (
      data?.candidate_id ||
      (
        typeof data?.body === "string"
          ? (() => {
              try {
                return JSON.parse(
                  data.body
                )?.candidate_id;
              } catch {
                return null;
              }
            })()
          : null
      )
    );

  } catch {
    /*
     * Timeout/network error.
     * Caller keeps using its fallback ID.
     */
    return null;
  }
}

export async function trackInteraction({
  job_id,
  candidate_id,
  action
}) {
  // SEC-14: never send malformed ids or an unbounded action label.
  if (!isSafeId(job_id) || !isSafeId(candidate_id)
      || typeof action !== "string" || action.length > 40) {
    return;
  }
  try {
    await authedFetch(
      `${API_BASE}/trackInteraction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          job_id,
          candidate_id,
          action
        })
      }
    );
  } catch {
    /*
     * Fire-and-forget.
     */
  }
}

/* =========================================================
   RECRUITERS
========================================================= */

export async function getRecruiterByUid(uid) {
  if (!isSafeId(uid)) return null;
  try {
    const res = await authedFetch(
      `${API_BASE}/recruiters?recruiter_id=${encodeURIComponent(uid)}`
    );

    if (!res.ok) {
      return null;
    }

    const data = await res.json();

    return (
      data.status === "success" &&
      data.recruiter
    )
      ? data.recruiter
      : null;

  } catch {
    return null;
  }
}

export async function registerRecruiter(
  {
    recruiter_id,
    email,
    organisation_name
  },
  {
    keepalive = false
  } = {}
) {
  const res = await authedFetch(
    `${API_BASE}/recruiters`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recruiter_id,
        email,
        organisation_name
      }),
      keepalive
    }
  );

  const rawText =
    await res.text();

  return {
    ok: res.ok,
    status: res.status,
    rawText
  };
}

export async function getRecruiters() {
  return apiFetch(
    "/recruiters",
    {},
    {
      throwOnError: true
    }
  );
}

/* =========================================================
   ADMIN
========================================================= */

export async function getAdminMetrics() {
  return apiFetch(
    "/admin/metrics",
    {},
    {
      throwOnError: true
    }
  );
}

/* =========================================================
   ACCOUNT ERASURE (backend records)
   Asks the backend to erase every record it holds for the signed-in
   user (the token, never a client-supplied id, says who). Returns
   "done", "failed" (the backend answered with an error: do not delete
   the account yet, so the request can be retried) or "unavailable"
   (route not deployed or unreachable). See LAMBDA_CHANGES.md L-09.
========================================================= */
export async function deleteAccountData() {
  try {
    const res = await authedFetch(
      `${API_BASE}/account/delete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }
    );
    if (res.ok) return "done";
    if ([404, 405, 501].includes(res.status)) return "unavailable";
    return "failed";
  } catch {
    return "unavailable";
  }
}

/* =========================================================
   POWER BI EMBED TOKEN
========================================================= */

// SEC-05: sends NO identity, email, role or report id. The backend derives
// the caller and the report they may see from the verified Firebase ID token
// (attached by authedFetch), so nothing here can be altered to ask for
// another user's or another role's report.
export async function getEmbedToken() {
  // The Authorization: Bearer <Firebase ID token> header is added by authedFetch.
  const res = await authedFetch(
    EMBED_URL_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    }
  );

  const data = await res.json();

  const payload =
    (
      data.body &&
      typeof data.body === "string"
    )
      ? JSON.parse(data.body)
      : data;

  if (!res.ok || payload.error) {
    const errDetail =
      (
        payload.error &&
        typeof payload.error === "object"
      )
        ? (
            payload.error.message ||
            payload.error.errorCode ||
            JSON.stringify(payload.error)
          )
        : (
            payload.error ||
            `HTTP ${res.status}`
          );

    return {
      ok: false,
      status: res.status,
      error: errDetail
    };
  }

  return {
    ok: true,
    accessToken:
      payload.embedToken ||
      payload.token ||
      payload.access_token,

    embedUrl:
      payload.embedUrl ||
      payload.embed_url,

    reportId:
      payload.reportId ||
      payload.report_id ||
      null,

    tokenType:
      payload.tokenType ||
      "1"
  };
}

/* =========================================================
   GEOCODING
   Nominatim primary, Photon fallback.
========================================================= */

// SEC-17: location privacy.
//  - Strings are reduced to city level before they leave the browser: any
//    part containing a digit (street numbers, postcodes) and "remote" markers
//    are dropped, at most three parts are kept, and the result is capped.
//  - The platform's own backend is asked first (GET /geocode?q=, see
//    LAMBDA_CHANGES.md L-10), so the browser does not have to contact a third
//    party at all.
//  - `sensitive: true` marks the location of a PERSON (a candidate). Such a
//    location is NEVER sent to a third-party geocoder: if the backend cannot
//    answer, nothing is plotted. Public job locations may still fall back to
//    the public providers until the backend route exists.
//  - Browsers ignore a script-set Referer header, so none is set.
let _backendGeocode = "unknown"; // "unknown" | "down" (route missing/unreachable)

export function coarsePlace(value) {
  const parts = String(value ?? "")
    .split(",")
    .map(p => p.trim())
    .filter(p => p && !/\d/.test(p) && !/^remote$/i.test(p) && !/\bremote\b/i.test(p))
    .slice(0, 3);
  return parts.join(", ").slice(0, 100);
}

// undefined = backend could not answer; null = answered, no match; {lat,lng} = answer
async function _geocodeViaBackend(place) {
  if (_backendGeocode === "down") return undefined;
  try {
    const res = await authedFetch(`${API_BASE}/geocode?${new URLSearchParams({ q: place })}`);
    if (res.ok) {
      let data = await res.json().catch(() => ({}));
      if (typeof data?.body === "string") { try { data = JSON.parse(data.body); } catch { data = {}; } }
      const lat = Number(data?.lat), lng = Number(data?.lng);
      return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
    }
    if ([404, 405, 501].includes(res.status)) _backendGeocode = "down";
    return undefined;
  } catch {
    _backendGeocode = "down"; // route missing or blocked: stop trying for this page
    return undefined;
  }
}

export async function geocodeLocation(
  locationStr,
  { sensitive = false } = {}
) {
  const place = coarsePlace(locationStr);
  if (!place) return null;

  const viaBackend = await _geocodeViaBackend(place);
  if (viaBackend !== undefined) return viaBackend;

  if (sensitive) return null; // never hand a person's location to a third party

  /*
   * Public job locations only. Primary: Nominatim
   */
  try {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(place)}` +
      `&format=json` +
      `&limit=1`;

    const res = await fetch(
      url,
      {
        headers: {
          "Accept-Language": "en"
        }
      }
    );

    if (res.ok) {
      const data =
        await res.json();

      if (data[0]) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon)
        };
      }
    }

  } catch {
    /*
     * Fall through to Photon.
     */
  }

  /*
   * Backup: Photon
   */
  try {
    const url =
      `https://photon.komoot.io/api/` +
      `?q=${encodeURIComponent(place)}` +
      `&limit=1` +
      `&lang=en`;

    const res =
      await fetch(url);

    if (res.ok) {
      const data =
        await res.json();

      const feat =
        data?.features?.[0];

      if (feat) {
        const [
          lng,
          lat
        ] =
          feat.geometry.coordinates;

        return {
          lat,
          lng
        };
      }
    }

  } catch {
    /*
     * Both providers failed.
     */
  }

  return null;
}

/* =========================================================
   LLM PROXY
========================================================= */

// SEC-08: the browser sends only the prompt and a coarse `feature` label
// (e.g. "know_more"). It never names a provider or model: the backend maps
// the feature to a provider itself and must ignore anything else. The
// Firebase ID token is attached by authedFetch, and the backend must verify
// it before the prompt is forwarded to any LLM provider.
export async function callLLM(
  prompt,
  feature = ""
) {
  // The Authorization: Bearer <Firebase ID token> header is added by authedFetch.
  const body = {
    prompt
  };

  if (feature) {
    body.feature = feature;
  }

  const res =
    await authedFetch(
      LLM_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify(body)
      }
    );

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}`
    );
  }

  const data =
    await res.json();

  return data?.result || "";
}
