/* =========================================================
   UTILS.JS
   Generic, framework-free helpers shared across pages: toasts,
   skeleton loaders, formatting, escaping, resume parsing, and
   the progress-bar helper used by both dashboards and admin.

   Nothing here touches Firebase or calls fetch() — those live
   in config.js/api.js. This file only touches the DOM and does
   plain-JS text/data transforms.
========================================================= */

/* =========================================================
   TOAST NOTIFICATIONS
   Replaces all native alert() calls. Types: "success" | "error"
   | "info" | "warning". Identical to the version previously in
   api.js — same markup/classes, so no CSS changes needed.
========================================================= */
(function injectToastStyles() {
  if (document.getElementById("bm-toast-styles")) return;
  const s = document.createElement("style");
  s.id = "bm-toast-styles";
  s.textContent = `
    #bm-toast-container {
      position: fixed; bottom: 28px; right: 28px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .bm-toast {
      display: flex; align-items: flex-start; gap: 12px;
      min-width: 280px; max-width: 380px; padding: 14px 16px;
      border-radius: 12px; border: 1px solid transparent;
      background: var(--surface, #0f1220); box-shadow: 0 8px 32px rgba(0,0,0,0.35);
      font-family: 'DM Sans', sans-serif; font-size: 13.5px;
      line-height: 1.45; color: var(--text-1, #e2e8f0); pointer-events: all;
      animation: bm-toast-in 0.28s cubic-bezier(.22,1,.36,1) both;
    }
    .bm-toast.bm-toast-out { animation: bm-toast-out 0.22s ease forwards; }
    .bm-toast-icon  { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
    .bm-toast-body  { flex: 1; }
    .bm-toast-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
    .bm-toast-msg   { color: var(--text-2, #9bb3ff); font-size: 12.5px; }
    .bm-toast-close {
      background: none; border: none; cursor: pointer;
      color: var(--text-muted, #4a5580); font-size: 16px; line-height: 1;
      padding: 0; flex-shrink: 0; margin-top: -1px; transition: color 0.15s;
    }
    .bm-toast-close:hover { color: var(--text-1, #e2e8f0); }
    .bm-toast.success { border-color: rgba(74,222,128,0.3); }
    .bm-toast.success .bm-toast-title { color: var(--green, #4ade80); }
    .bm-toast.error   { border-color: rgba(248,113,113,0.3); }
    .bm-toast.error   .bm-toast-title { color: var(--red, #f87171); }
    .bm-toast.warning { border-color: rgba(251,191,36,0.3); }
    .bm-toast.warning .bm-toast-title { color: var(--amber, #fbbf24); }
    .bm-toast.info    { border-color: rgba(122,162,255,0.3); }
    .bm-toast.info    .bm-toast-title { color: var(--blue, #7aa2ff); }
    @keyframes bm-toast-in  { from { opacity:0; transform:translateY(14px) scale(.97); } to { opacity:1; transform:none; } }
    @keyframes bm-toast-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(6px); } }
  `;
  document.head.appendChild(s);
})();

// SEC-12: the ONLY way first-party code writes to the console. It records a
// short label and the error's code or type (for example "permission-denied"
// or "TypeError") and nothing else: never the message (which can echo
// document paths, ids, emails or response text), the request or response
// body, tokens, or user and candidate objects. Debug `console.log` output
// was removed, and no switch re-enables it.
export function logError(context, err) {
  const code = (err && (err.code || err.name)) || "error";
  console.error(`[BeyondMatch] ${context} (${code})`);
}

export function showToast(message, type = "info", title = "") {
  let container = document.getElementById("bm-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "bm-toast-container";
    document.body.appendChild(container);
  }

  const icons  = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
  const titles = {
    success: title || "Success",
    error:   title || "Error",
    warning: title || "Warning",
    info:    title || "Info"
  };

  const toast = document.createElement("div");
  toast.className = `bm-toast ${type}`;
  toast.innerHTML = `
    <span class="bm-toast-icon">${icons[type] || icons.info}</span>
    <div class="bm-toast-body">
      <div class="bm-toast-title">${escHtml(titles[type])}</div>
      <div class="bm-toast-msg"></div>
    </div>
    <button class="bm-toast-close" aria-label="Dismiss">&#x2715;</button>
  `;
  // textContent: messages often carry error text / user data (SEC-03)
  toast.querySelector(".bm-toast-msg").textContent = String(message ?? "");

  const dismiss = () => {
    toast.classList.add("bm-toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };

  toast.querySelector(".bm-toast-close").addEventListener("click", dismiss);
  container.appendChild(toast);
  setTimeout(dismiss, type === "error" ? 6000 : 4000);
}
// Kept on window too — several pages call showToast() from inline
// onclick="" HTML attributes, which only see globals, not module scope.
window.showToast = showToast;


/* =========================================================
   SKELETON LOADERS — generic job/candidate grid placeholders.
   (Page-specific card skeletons, e.g. the applications-list
   skeletons on cand_actions.html/rec-actions.html, render
   different markup and stay local to candidate.js/recruiter.js.)
========================================================= */
export function showJobsSkeletonLoader(container, count = 5) {
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="job-card skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-btn"></div>
    </div>
  `).join("");
}

export function showCandidatesSkeletonLoader(container, count = 4) {
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="cand-card skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-btn"></div>
    </div>
  `).join("");
}


/* =========================================================
   PROGRESS BAR
   admin.html resets the bar's width to 0 after completion;
   rec-dash.html fades it out via opacity instead. Both
   behaviors are preserved via the `resetStyle` option so
   admin.js and recruiter.js each get their original look.
========================================================= */
export function setProgress(percent, { barId = "lbar", resetStyle = "width" } = {}) {
  const el = document.getElementById(barId);
  if (!el) return;
  if (resetStyle === "opacity") el.style.opacity = "1"; // undo a previous completion fade-out
  el.style.width = percent + "%";
  if (percent >= 100) {
    setTimeout(() => {
      if (resetStyle === "opacity") el.style.opacity = "0";
      else el.style.width = "0";
    }, 600);
  }
}

export function showErrorBanner(msg, bannerId = "errBanner") {
  const b = document.getElementById(bannerId);
  if (b) { b.textContent = msg; b.style.display = "block"; }
}


/* =========================================================
   FORMATTING / ESCAPING
   Consolidates the identical copies previously duplicated in
   api.js/savedjobs.js (formatSalary) and cand_actions.html/
   rec-actions.html (escHtml/escAttr/decodeAttr/timeSince/
   statusColor/statusIcon).
========================================================= */
export function formatSalary(job) {
  const min = job.salary_min;
  const max = job.salary_max;
  if (!min && !max) return "Salary not disclosed";
  if (min && max) {
    return min === max
      ? `$${Math.round(min).toLocaleString()}`
      : `$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}`;
  }
  if (min) return `From $${Math.round(min).toLocaleString()}`;
  if (max) return `Up to $${Math.round(max).toLocaleString()}`;
  return "Salary not disclosed";
}

// SEC-03: escapes every character that can break out of an HTML text node
// or a quoted attribute value. escAttr is the same escaping, kept as a
// self-contained function for call sites. NOTE: neither is safe inside an inline
// on*="" handler or a javascript: URL — the HTML parser decodes entities
// before the JS runs. Use data-* attributes + addEventListener there.
export function escHtml(s) {
  return String(s ?? "").replace(/[&<>"'`]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
}

export function escAttr(s) {
  return String(s ?? "").replace(/[&<>"'`]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
}

// SEC-03: returns the URL only if it parses as http(s); otherwise "".
// Use for every href/src built from API, Firestore or LLM data.
export function safeUrl(u) {
  try {
    const url = new URL(String(u ?? "").trim(), window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

// SEC-03: builds a mailto: URL only for a plausible single email address;
// returns "" otherwise. The subject is percent-encoded.
export function safeMailto(email, subject = "") {
  const addr = String(email ?? "").trim();
  if (!/^[^\s@<>"'`,;:()\\]+@[^\s@<>"'`,;:()\\]+\.[^\s@<>"'`,;:()\\]+$/.test(addr)) return "";
  return `mailto:${addr}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}

export function decodeAttr(s) {
  return String(s || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

export function timeSince(date) {
  const sec = Math.floor((new Date() - date) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function statusColor(s) {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  return (light
    ? { applied: "#3a5fd9", reviewing: "#b45309", shortlisted: "#7c3aed", interview: "#0e7490", hired: "#157a3d", rejected: "#dc2626" }
    : { applied: "#7aa2ff", reviewing: "#fbbf24", shortlisted: "#c084fc", interview: "#38bdf8", hired: "#4ade80", rejected: "#f87171" }
  )[s] || (light ? "#3a5fd9" : "#7aa2ff");
}

export function statusIcon(s) {
  return {
    applied: "●", reviewing: "◐", shortlisted: "★",
    interview: "◆", hired: "✓", rejected: "✕"
  }[s] || "●";
}


/* =========================================================
   NOTIFICATION PANEL TOGGLE
   The Firestore subscription itself (subscribeNotifications)
   differs by role and stays in candidate.js/recruiter.js —
   this open/close toggle is the only role-agnostic DOM part.
========================================================= */
export function toggleNotifPanel(panelId = "notifPanel") {
  document.getElementById(panelId)?.classList.toggle("open");
}
window.toggleNotifPanel = toggleNotifPanel; // used from inline onclick=""


/* =========================================================
   SCRIPT LOADER
   Used to lazy-load pdf.js/mammoth on pages that don't
   preload them in <head> (rec-postjob.html's JD-parse
   feature), without needing to edit that page's <head>.
========================================================= */
export function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    // SEC-07: Subresource Integrity — the browser refuses the file if its
    // bytes differ from the pinned hash.
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// SEC-07: pinned versions + SRI hashes. Keep in sync with the <script> tags in
// the HTML pages and with package.json. The pdf.js worker cannot carry an
// SRI hash (browsers do not support integrity on Worker scripts).
const PDFJS_URL    = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_SRI    = "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAMMOTH_URL  = "https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js";
const MAMMOTH_SRI  = "sha384-8NWE3bZDrmRI4IePMoQaEoLhAQ1MmRMJkdNgnGiHRFanTqsFKr0TmK6aSZvFJ/PO";

// pdf.js 3.11.174 is affected by CVE-2024-4367 (arbitrary JS via a crafted
// font) and there is no patched 3.x release. Turning off isEvalSupported is
// the vendor-documented mitigation: it disables the vulnerable code path.
const PDFJS_SAFE_OPTIONS = { isEvalSupported: false };

async function ensurePdfJs() {
  if (!window.pdfjsLib) await loadScript(PDFJS_URL, PDFJS_SRI);
  // Idempotent — safe to set even if a page preloaded pdf.js itself via a
  // <script defer> tag rather than through this function.
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
}

async function ensureMammoth() {
  if (!window.mammoth) await loadScript(MAMMOTH_URL, MAMMOTH_SRI);
}


/* =========================================================
   RESUME PARSING (plain text)
   Used for candidate signup (auth.js), resume re-analysis
   (candidate.js / resume.html), and bulk lead matching
   (recruiter.js / rec-leads.html). Joins all text on a page
   with spaces — fine where only keyword content matters.
========================================================= */
export async function parseResumeFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    await ensurePdfJs();
    const buffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buffer, ...PDFJS_SAFE_OPTIONS }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(x => x.str).join(" ") + "\n";
    }
    return text;
  }

  if (ext === "docx") {
    await ensureMammoth();
    const buffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
  }

  throw new Error("Unsupported file type");
}


/* =========================================================
   DOCUMENT PARSING (layout-preserving)
   Used only by recruiter.js's job-description AI-parse feature
   (rec-postjob.html), where line breaks matter for the LLM to
   correctly separate title/requirements/responsibilities. This
   is deliberately a separate function from parseResumeFile
   above, not a duplicate of it — it reconstructs line breaks
   from each text item's Y-position instead of joining everything
   with spaces.
========================================================= */
export async function parseDocumentWithLayout(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "docx") {
    await ensureMammoth();
    const buffer = await file.arrayBuffer();
    return (await window.mammoth.extractRawText({ arrayBuffer: buffer })).value;
  }

  await ensurePdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer, ...PDFJS_SAFE_OPTIONS }).promise;
  const LINE_GAP_THRESHOLD = 2; // pt — smaller than this = same line
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const content = await pg.getTextContent();

    const lines = [];
    let currentLine = [];
    let lastY = null;

    for (const item of content.items) {
      const y = item.transform ? item.transform[5] : null;
      const str = item.str || "";

      if (lastY === null) {
        currentLine.push(str);
      } else if (Math.abs(y - lastY) > LINE_GAP_THRESHOLD) {
        const joined = currentLine.join(" ").trim();
        if (joined) lines.push(joined);
        currentLine = [str];
      } else {
        currentLine.push(str);
      }

      if (item.hasEOL) {
        const joined = currentLine.join(" ").trim();
        if (joined) lines.push(joined);
        currentLine = [];
        lastY = null;
        continue;
      }

      lastY = y;
    }

    if (currentLine.length) {
      const joined = currentLine.join(" ").trim();
      if (joined) lines.push(joined);
    }

    pages.push(lines.join("\n"));
  }

  return pages.join("\n\n");
}


/* =========================================================
   ENTITY MAP (Leaflet)
   Consolidates the near-identical map/marker/tooltip logic
   previously duplicated between locatehire.js (candidate view
   of jobs) and rec-locatehire.js (recruiter view of candidates).
   The caller supplies how to group/label/tooltip its own entity
   type; this module owns the actual Leaflet wiring, geocoding
   cache, and floating-tooltip DOM element.
========================================================= */
import { geocodeLocation } from "./api.js";

// SEC-17: where geocoding results are kept.
//  - Public JOB locations: sessionStorage (this tab only, gone when it closes,
//    and cleared at logout), under a new key.
//  - A PERSON's (candidate's) location: memory only, never written to storage.
//  - The old `localStorage` cache (permanent, survived logout and was shared by
//    everyone using the browser) is deleted whenever it is found.
const GEOCACHE_KEY    = "bm_geocode_cache_v2";
const LEGACY_GEOCACHE = "bm_geocode_cache_v1";
let _memoryGeoCache = {};

// Wipes every geocode cache; used at logout and when an account is deleted.
export function clearGeocodeCache() {
  _memoryGeoCache = {};
  try { sessionStorage.removeItem(GEOCACHE_KEY); } catch { /* storage unavailable */ }
  try { localStorage.removeItem(LEGACY_GEOCACHE); } catch { /* storage unavailable */ }
}

function loadGeoCache() {
  try { localStorage.removeItem(LEGACY_GEOCACHE); } catch { /* storage unavailable */ }
  try { return JSON.parse(sessionStorage.getItem(GEOCACHE_KEY) || "{}"); } catch { return {}; }
}
function saveGeoCache(cache) {
  try { sessionStorage.setItem(GEOCACHE_KEY, JSON.stringify(cache)); } catch { /* storage full */ }
}

// ── Floating tooltip (one shared DOM element, module-scoped) ──
let _tipEl = null;

function _getTip() {
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement("div");
  _tipEl.id = "bm-map-tip";
  _tipEl.style.cssText = [
    "position:fixed", "pointer-events:none", "z-index:9999",
    "display:none", "opacity:0",
    "transition:opacity 0.15s ease,transform 0.15s ease",
    "transform:translateY(8px)"
  ].join(";");
  document.body.appendChild(_tipEl);
  return _tipEl;
}

function _showTip(e, html) {
  const tip = _getTip();
  tip.innerHTML = html;
  tip.style.display = "block";
  requestAnimationFrame(() => {
    tip.style.opacity = "1";
    tip.style.transform = "translateY(0)";
  });
  _moveTip(e);
}

function _moveTip(e) {
  const tip = _getTip();
  const W = tip.offsetWidth, H = tip.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX + 18, y = e.clientY - H / 2;
  if (x + W > vw - 12) x = e.clientX - W - 14;
  if (y < 8) y = 8;
  if (y + H > vh - 8) y = vh - H - 8;
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
}

function _hideTip() {
  const tip = _getTip();
  tip.style.opacity   = "0";
  tip.style.transform = "translateY(8px)";
  setTimeout(() => { if (tip.style.opacity === "0") tip.style.display = "none"; }, 180);
}

document.addEventListener("mousemove", e => {
  if (_tipEl && _tipEl.style.display !== "none") _moveTip(e);
});

function _dotIcon(matched) {
  const bg = matched ? "#4ade80" : "#7aa2ff";
  const bd = matched ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.5)";
  const sh = matched
    ? "0 0 0 3px rgba(74,222,128,0.25),0 2px 8px rgba(22,163,74,0.5)"
    : "0 0 0 3px rgba(122,162,255,0.2),0 2px 6px rgba(79,70,229,0.4)";
  return L.divIcon({
    html:        `<div style="width:14px;height:14px;border-radius:50%;background:${bg};border:2px solid ${bd};box-shadow:${sh};box-sizing:border-box;"></div>`,
    className:   "",
    iconSize:    [14, 14],
    iconAnchor:  [7, 7],
    popupAnchor: [0, -10]
  });
}

/**
 * Creates a clustered Leaflet map with match-aware green/blue markers.
 *
 * @param {Object} opts
 * @param {string} [opts.containerId="map"]
 * @param {(entity) => string} opts.getLocationKey  — grouping key for one entity
 * @param {(entity) => {lat,lng}|null} opts.getLatLng — direct coords if already known
 * @param {(entity) => string} opts.getLocationString — geocodable address if no coords
 * @param {(entities: Array) => string} opts.buildTooltipHTML
 * @param {(title: string, entities: Array) => void} opts.onMarkerClick
 * @param {Set<string>} [opts.matchedIds] — ids considered "matched" (rendered green)
 * @param {(entity) => string} [opts.getEntityId]
 * @returns {{ map, markersLayer, addEntities(entities), refreshMarkerStyles(matchedIds) }}
 */
export function createEntityMap({
  containerId = "map",
  getLocationKey,
  getLatLng,
  getLocationString,
  buildTooltipHTML,
  onMarkerClick,
  matchedIds = new Set(),
  // true when the entities are PEOPLE (candidates): their locations are never
  // sent to a third-party geocoder and never written to browser storage.
  geocodeSensitive = false,
  getEntityId = e => String(e.job_id ?? e.candidate_id ?? e.id)
}) {
  const map = L.map(containerId).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap"
  }).addTo(map);

  const markersLayer = L.markerClusterGroup({
    maxClusterRadius: 40,
    iconCreateFunction(cluster) {
      const childMarkers = cluster.getAllChildMarkers();
      const total = childMarkers.reduce((sum, m) => sum + (m._bmEntities?.length || 1), 0);
      const hasMatch = childMarkers.some(m => m._bmEntities?.some(e => matchedIds.has(getEntityId(e))));
      return L.divIcon({
        html: `<div class="cluster-icon${hasMatch ? " matched" : ""}">${total}</div>`,
        className: "",
        iconSize: L.point(36, 36)
      });
    }
  });

  markersLayer.on("clustermouseover", e => {
    const entities = e.layer.getAllChildMarkers().flatMap(m => m._bmEntities || []);
    _showTip(e.originalEvent || window.event, buildTooltipHTML(entities));
  });
  markersLayer.on("clustermousemove", e => _moveTip(e.originalEvent || window.event));
  markersLayer.on("clustermouseout", () => _hideTip());
  markersLayer.addTo(map);

  function _makeMarker(loc) {
    const hasMatch = loc.entities.some(e => matchedIds.has(getEntityId(e)));
    const marker = L.marker([loc.lat, loc.lng], { icon: _dotIcon(hasMatch) });
    marker._bmEntities = loc.entities;
    marker._bmTitle    = loc.title;
    marker.on("mouseover", e => _showTip(e.originalEvent || window.event, buildTooltipHTML(loc.entities)));
    marker.on("mousemove", e => _moveTip(e.originalEvent || window.event));
    marker.on("mouseout",  () => _hideTip());
    marker.on("click",     () => onMarkerClick(loc.title, loc.entities));
    return marker;
  }

  function refreshMarkerStyles(newMatchedIds) {
    if (newMatchedIds) matchedIds = newMatchedIds;
    markersLayer.eachLayer(marker => {
      if (!marker._bmEntities) return;
      const hasMatch = marker._bmEntities.some(e => matchedIds.has(getEntityId(e)));
      marker.setIcon(_dotIcon(hasMatch));
    });
    markersLayer.refreshClusters();
  }

  // Groups entities by location, places already-geocoded ones immediately,
  // geocodes the rest (concurrency 3, 350ms stagger, cached per tab; see SEC-17).
  async function addEntities(entities) {
    const locationMap = {};

    for (const entity of entities) {
      const direct = getLatLng(entity);
      if (direct?.lat && direct?.lng) {
        const k = `${direct.lat},${direct.lng}`;
        if (!locationMap[k]) locationMap[k] = { lat: +direct.lat, lng: +direct.lng, title: getLocationKey(entity), entities: [] };
        locationMap[k].entities.push(entity);
        continue;
      }
      const locStr = getLocationString(entity);
      if (!locStr) continue;
      const k = locStr.trim().toLowerCase();
      if (!locationMap[k]) locationMap[k] = { locStr, title: locStr, entities: [], needsGeocode: true };
      locationMap[k].entities.push(entity);
    }

    const geoCache  = geocodeSensitive ? _memoryGeoCache : loadGeoCache();
    const toFetch   = Object.values(locationMap).filter(loc => loc.needsGeocode);
    const cacheHits = toFetch.filter(loc => geoCache[loc.locStr.toLowerCase()] !== undefined);
    const cacheMiss = toFetch.filter(loc => geoCache[loc.locStr.toLowerCase()] === undefined);

    for (const loc of cacheHits) {
      const coords = geoCache[loc.locStr.toLowerCase()];
      if (coords) { loc.lat = coords.lat; loc.lng = coords.lng; }
    }

    [...Object.values(locationMap).filter(l => !l.needsGeocode), ...cacheHits.filter(l => l.lat && l.lng)]
      .forEach(loc => _makeMarker(loc).addTo(markersLayer));

    const CONCURRENCY = 3;
    const STAGGER_MS  = 350;
    let cacheUpdated  = false;

    async function geocodeOne(loc, delayMs) {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      const key = loc.locStr.toLowerCase();
      const coords = await geocodeLocation(loc.locStr, { sensitive: geocodeSensitive });
      geoCache[key] = coords;
      cacheUpdated = true;
      if (coords) {
        loc.lat = coords.lat;
        loc.lng = coords.lng;
        _makeMarker(loc).addTo(markersLayer);
      }
    }

    for (let i = 0; i < cacheMiss.length; i += CONCURRENCY) {
      await Promise.all(cacheMiss.slice(i, i + CONCURRENCY).map((loc, bi) => geocodeOne(loc, bi * STAGGER_MS)));
      if (i + CONCURRENCY < cacheMiss.length) await new Promise(r => setTimeout(r, 1000));
    }

    if (cacheUpdated && !geocodeSensitive) saveGeoCache(geoCache);
  }

  return { map, markersLayer, addEntities, refreshMarkerStyles };
}

// ── Country code → display name (used by the job-map tooltip) ──
const COUNTRY_CODES = {
  US: "United States", GB: "United Kingdom", AU: "Australia",  IN: "India",
  CA: "Canada",        DE: "Germany",        FR: "France",     NL: "Netherlands",
  SG: "Singapore",     AE: "UAE",            NZ: "New Zealand",IE: "Ireland",
  PK: "Pakistan",      NG: "Nigeria",        ZA: "South Africa",KE: "Kenya",
  BR: "Brazil",        MX: "Mexico",         JP: "Japan",      CN: "China",
  KR: "South Korea",   SE: "Sweden",         NO: "Norway",     DK: "Denmark",
  FI: "Finland",       CH: "Switzerland",    ES: "Spain",      IT: "Italy",
  PL: "Poland",        PT: "Portugal",       PH: "Philippines",MY: "Malaysia",
  TH: "Thailand"
};

export function resolveCountryLabel(jobs) {
  const freq = {};
  jobs.forEach(j => {
    const c = (j.country || "").toUpperCase();
    if (c) freq[c] = (freq[c] || 0) + 1;
  });
  const topCode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topCode && COUNTRY_CODES[topCode]) return COUNTRY_CODES[topCode];
  if (topCode?.length === 2) return topCode;

  const loc = jobs.map(j => j.location_display || j.location || "").find(Boolean);
  if (loc) {
    const parts = loc.split(",").map(s => s.trim());
    return parts[parts.length - 1] || loc;
  }
  return "Unknown";
}

// ── Country-from-location-string detection ──
// Shared by rec-jobs.html (region tabs) and ukjobs.html (UK-only filter) —
// kept here so both call one function instead of keeping two copies of
// this fairly large lookup table in sync.
const KNOWN_COUNTRIES = new Set([
  "Afghanistan","Albania","Algeria","Andorra","Angola","Argentina","Armenia","Australia",
  "Austria","Azerbaijan","Bahrain","Bangladesh","Belarus","Belgium","Belize","Benin",
  "Bolivia","Bosnia","Botswana","Brazil","Brunei","Bulgaria","Cambodia","Cameroon","Canada",
  "Chile","China","Colombia","Croatia","Cuba","Cyprus","Czechia","Czech Republic","Denmark",
  "Ecuador","Egypt","Estonia","Ethiopia","Finland","France","Georgia","Germany","Ghana",
  "Greece","Guatemala","Honduras","Hungary","Iceland","India","Indonesia","Iran","Iraq",
  "Ireland","Israel","Italy","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kuwait",
  "Latvia","Lebanon","Libya","Lithuania","Luxembourg","Malaysia","Mali","Malta","Mexico",
  "Moldova","Mongolia","Morocco","Mozambique","Myanmar","Nepal","Netherlands","New Zealand",
  "Nicaragua","Nigeria","Norway","Oman","Pakistan","Panama","Paraguay","Peru","Philippines",
  "Poland","Portugal","Qatar","Romania","Russia","Saudi Arabia","Senegal","Serbia",
  "Singapore","Slovakia","Slovenia","Somalia","South Africa","South Korea","Spain",
  "Sri Lanka","Sudan","Sweden","Switzerland","Syria","Taiwan","Tanzania","Thailand",
  "Tunisia","Turkey","Uganda","Ukraine","United Arab Emirates","UAE","United Kingdom",
  "UK","United States","USA","US","Uruguay","Uzbekistan","Venezuela","Vietnam","Yemen",
  "Zambia","Zimbabwe",
  "NL","DE","FR","ES","AU","CA","IT","GB","BR","MX","IN","JP","CN","KR","SG","HK",
  "ZA","AR","CL","CO","PL","SE","NO","DK","FI","BE","AT","CH","PT","GR","RO","HU",
  "CZ","SK","HR","BG","RS","SI","LT","LV","EE","TH","VN","PH","MY","ID","PK","BD",
  "EG","SA","AE","IL","IR","IQ","TR","NG","KE","GH","ET","TZ","UG","MA","DZ","TN"
]);

const COUNTRY_DISPLAY = {
  "US": "United States", "USA": "United States",
  "UK": "United Kingdom", "GB": "United Kingdom",
  "UAE": "United Arab Emirates", "AE": "United Arab Emirates",
  "DE": "Germany", "FR": "France", "ES": "Spain", "IT": "Italy",
  "NL": "Netherlands", "BE": "Belgium", "AT": "Austria", "CH": "Switzerland",
  "SE": "Sweden", "NO": "Norway", "DK": "Denmark", "FI": "Finland",
  "PL": "Poland", "PT": "Portugal", "GR": "Greece", "RO": "Romania",
  "HU": "Hungary", "CZ": "Czechia", "SK": "Slovakia", "HR": "Croatia",
  "BG": "Bulgaria", "RS": "Serbia", "SI": "Slovenia",
  "LT": "Lithuania", "LV": "Latvia", "EE": "Estonia",
  "CA": "Canada", "AU": "Australia", "NZ": "New Zealand",
  "BR": "Brazil", "MX": "Mexico", "AR": "Argentina", "CL": "Chile",
  "CO": "Colombia", "IN": "India", "CN": "China", "JP": "Japan",
  "KR": "South Korea", "SG": "Singapore", "MY": "Malaysia",
  "TH": "Thailand", "VN": "Vietnam", "PH": "Philippines",
  "ID": "Indonesia", "PK": "Pakistan", "BD": "Bangladesh",
  "HK": "Hong Kong", "TW": "Taiwan", "IL": "Israel", "TR": "Turkey",
  "SA": "Saudi Arabia", "IR": "Iran", "IQ": "Iraq",
  "NG": "Nigeria", "KE": "Kenya", "GH": "Ghana", "ZA": "South Africa",
  "EG": "Egypt", "MA": "Morocco", "DZ": "Algeria", "TN": "Tunisia"
};

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC"
]);

const CITY_TO_COUNTRY = {
  "berlin":"Germany","hamburg":"Germany","munich":"Germany","münchen":"Germany",
  "frankfurt":"Germany","cologne":"Germany","köln":"Germany","stuttgart":"Germany",
  "düsseldorf":"Germany","dortmund":"Germany","essen":"Germany","leipzig":"Germany",
  "nuremberg":"Germany","nürnberg":"Germany","bremen":"Germany","hannover":"Germany",
  "augsburg":"Germany","wiesbaden":"Germany","bonn":"Germany","karlsruhe":"Germany",
  "mannheim":"Germany","hesse":"Germany","bavaria":"Germany","saxony":"Germany",
  "london":"United Kingdom","manchester":"United Kingdom","birmingham":"United Kingdom",
  "leeds":"United Kingdom","glasgow":"United Kingdom","liverpool":"United Kingdom",
  "bristol":"United Kingdom","edinburgh":"United Kingdom","cardiff":"United Kingdom",
  "belfast":"United Kingdom","sheffield":"United Kingdom","bradford":"United Kingdom",
  "guisborough":"United Kingdom","buckinghamshire":"United Kingdom",
  "cheshire":"United Kingdom","somerset":"United Kingdom","newport pagnell":"United Kingdom",
  "south west england":"United Kingdom","county tyrone":"United Kingdom",
  "england":"United Kingdom","scotland":"United Kingdom","wales":"United Kingdom",
  "paris":"France","marseille":"France","lyon":"France","toulouse":"France",
  "nice":"France","nantes":"France","strasbourg":"France","bordeaux":"France",
  "madrid":"Spain","barcelona":"Spain","valencia":"Spain","seville":"Spain","bilbao":"Spain",
  "amsterdam":"Netherlands","rotterdam":"Netherlands","the hague":"Netherlands",
  "utrecht":"Netherlands","eindhoven":"Netherlands",
  "bangalore":"India","bengaluru":"India","mumbai":"India","delhi":"India",
  "hyderabad":"India","chennai":"India","pune":"India","kolkata":"India",
  "ahmedabad":"India","jaipur":"India","surat":"India","noida":"India",
  "gurgaon":"India","gurugram":"India","telangana":"India","ghaziabad":"India",
  "tamil nadu":"India","karnataka":"India","maharashtra":"India",
  "new york":"United States","los angeles":"United States","chicago":"United States",
  "houston":"United States","phoenix":"United States","philadelphia":"United States",
  "san antonio":"United States","san diego":"United States","dallas":"United States",
  "san jose":"United States","austin":"United States","jacksonville":"United States",
  "san francisco":"United States","columbus":"United States","seattle":"United States",
  "denver":"United States","nashville":"United States","oklahoma city":"United States",
  "davidson county":"United States","fulton county":"United States",
  "clark county":"United States","saint louis county":"United States",
  "orange county":"United States","san diego county":"United States",
  "oakland county":"United States",
  "são paulo":"Brazil","sao paulo":"Brazil","rio de janeiro":"Brazil","brasília":"Brazil",
  "sydney":"Australia","melbourne":"Australia","brisbane":"Australia",
  "perth":"Australia","adelaide":"Australia","canberra":"Australia",
  "toronto":"Canada","vancouver":"Canada","montreal":"Canada","montréal":"Canada",
  "calgary":"Canada","ottawa":"Canada","edmonton":"Canada",
  "mexico city":"Mexico","guadalajara":"Mexico","monterrey":"Mexico"
};

// Derives a country-level label from a full location string.
export function getRegionLabel(loc) {
  if (!loc) return null;
  const cleanLoc = loc.replace(/,?\s*REMOTE\b/gi, "").trim();
  const parts = cleanLoc.split(",").map(p => p.trim()).filter(Boolean);

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    const upper = p.toUpperCase();

    if (COUNTRY_DISPLAY[upper]) return COUNTRY_DISPLAY[upper];
    if (COUNTRY_DISPLAY[p])     return COUNTRY_DISPLAY[p];

    const pLower = p.toLowerCase();
    for (const country of KNOWN_COUNTRIES) {
      if (country.toLowerCase() === pLower) {
        return COUNTRY_DISPLAY[country] || country;
      }
    }

    if (US_STATES.has(upper)) return "United States";

    const noCounty = pLower.replace(/\s+county$/i, "").trim();
    if (CITY_TO_COUNTRY[noCounty]) return CITY_TO_COUNTRY[noCounty];
  }

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].toLowerCase();
    if (CITY_TO_COUNTRY[key]) return CITY_TO_COUNTRY[key];
  }

  if (!cleanLoc || /^remote$/i.test(cleanLoc)) return "REMOTE";

  if (parts.length === 1) return parts[0];
  return null;
}

const ROLE_KEYWORDS = {
  "Backend Developer":    ["backend", "node", "django", "flask", "api", "database", "express"],
  "Frontend Developer":   ["frontend", "html", "css", "react", "ui"],
  "Full Stack Developer": ["full stack", "mern", "frontend", "backend"],
  "Software Engineer":    ["software engineer", "java", "javascript"],
  "Data Scientist":       ["machine learning", "deep learning", "statistics", "model"],
  "Data Analyst":         ["data analyst", "power bi", "tableau", "excel", "analytics"],
  "DevOps Engineer":      ["docker", "kubernetes", "aws", "ci/cd"],
  "AI Engineer":          ["nlp", "computer vision", "llm"]
};

export function inferRoleFromResume(text = "") {
  const t = text.toLowerCase();
  let bestRole = "General", maxScore = 0;
  for (const role in ROLE_KEYWORDS) {
    const score = ROLE_KEYWORDS[role].filter(k => t.includes(k)).length;
    if (score > maxScore) { maxScore = score; bestRole = role; }
  }
  return bestRole;
}
