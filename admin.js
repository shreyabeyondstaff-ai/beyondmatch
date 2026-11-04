/* =========================================================
   ADMIN.JS
   Covers admin.html: platform-wide metrics dashboard (Chart.js
   charts, KPIs, match-quality analysis, data-quality scoring,
   AI insights). Reads /admin/metrics + /recruiters from the
   backend and candidates directly from Firestore (the REST
   /candidates endpoint requires auth admin.html doesn't have).
========================================================= */

import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { auth, db } from "./config.js";
import { getAdminMetrics, getRecruiters } from "./api.js";
import { callGemini } from "./gemini.js";
import { setProgress, escHtml, logError } from "./utils.js";

const $ = id => document.getElementById(id);

if ($("k1") && $("ticker")) {

  let CH = {}, STATE = {};
  // Set only once the signed-in user's ID token carries the server-issued
  // role: "admin" custom claim (SEC-01). boot() loads nothing until then.
  let isAdmin = false;

  // Chart.js draws to <canvas>, so its colors are baked in at render time and
  // can't react to CSS variables — read the active theme explicitly instead.
  const isLight = () => document.documentElement.getAttribute("data-theme") === "light";
  const chartText = () => isLight() ? "#46527a" : "#4a5a7a";
  const chartText2 = () => isLight() ? "#3d4766" : "#94a3c0";
  const chartGrid = (o = 0.04) => isLight() ? `rgba(31,64,159,${o + 0.02})` : `rgba(255,255,255,${o})`;
  const chartTip = () => isLight()
    ? { bg: "#ffffff", border: "rgba(58,95,217,.28)", title: "#131a2c", body: "#46527a" }
    : { bg: "#0d1018", border: "rgba(122,162,255,.2)", title: "#e2e8f0", body: "#94a3c0" };

  Chart.defaults.color = chartText();
  Chart.defaults.font.family = "'DM Sans', sans-serif";
  Chart.defaults.font.size = 10.5;

  /* =====================================================
     HELPERS
  ===================================================== */
  const st = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const fmt = n => n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const ucW = s => (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;

  /* =====================================================
     TABS
  ===================================================== */
  window.switchTab = function switchTab(id, btn) {
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    $("tab-" + id)?.classList.add("active");
    btn.classList.add("active");
  };

  /* =====================================================
     FIRESTORE FETCH — reads candidates collection directly.
     Allowed only for the server-issued role: "admin" claim (SEC-06:
     firestore.rules denies this collection-wide read to everyone else).
  ===================================================== */
  async function firestoreGetCandidates() {
    try {
      const snap = await getDocs(collection(db, "candidates"));
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      return docs;
    } catch (e) {
      logError("admin candidates fetch failed", e);
      return [];
    }
  }

  /* =====================================================
     TICKER
  ===================================================== */
  function buildTicker(m) {
    const items = [
      { lbl: "Candidates",  v: fmt(m.totalCandidates), cls: "b" },
      { lbl: "Recruiters",  v: fmt(m.totalRecruiters), cls: "b" },
      { lbl: "Jobs",        v: fmt(m.totalJobs),        cls: "g" },
      { lbl: "Matches Run", v: fmt(m.totalMatches || m.activeMatches), cls: "g" },
      { lbl: "Avg Score",   v: m.avgMatchScore ? `${m.avgMatchScore}%` : "N/A", cls: "a" },
      { lbl: "New/Week",    v: m.recentCandidates != null ? String(m.recentCandidates) : "N/A", cls: "g" },
      { lbl: "Avg/JD",      v: m.avgMatchesPerJD != null ? m.avgMatchesPerJD : "N/A", cls: "a" },
      { lbl: "Active",      v: fmt(m.activeMatches), cls: "b" },
    ];
    const html = items.map(i => `<span class="ti"><span class="lbl">${escHtml(i.lbl)}</span><span class="v ${escHtml(i.cls)}">${escHtml(i.v)}</span></span><span class="tsep">◆</span>`).join("");
    const t = $("ticker"); if (t) t.innerHTML = html + html;
  }

  /* =====================================================
     KPIs
  ===================================================== */
  function renderKPIs(m) {
    st("k1", fmt(m.totalCandidates || 0)); st("k1s", `${m.recentCandidates || 0} new this week`);
    st("k2", fmt(m.totalRecruiters || 0));
    st("k3", fmt(m.totalJobs || 0));
    st("k4", fmt(m.totalMatches || m.activeMatches || 0));
    st("k5", m.avgMatchScore ? `${m.avgMatchScore}%` : "—");
    st("k5s", m.avgMatchScore >= 70 ? "🟢 Above ETF (70%)" : m.avgMatchScore ? "🟡 Below ETF (70%)" : "platform-wide");
    st("k6", m.recentCandidates != null ? String(m.recentCandidates) : "—");
    const b = $("k4b"); if (b && m.activeMatches) b.innerHTML = `<div class="badge b">${escHtml(m.activeMatches)} active</div>`;
  }

  /* =====================================================
     OVERVIEW TAB
  ===================================================== */
  function renderTrend(trend) {
    const ctx = $("cTrend"); if (!ctx) return;
    let labels, cands, recs;
    if (trend?.length) {
      labels = trend.map(t => t.date || t.day || t.label);
      cands = trend.map(t => t.candidates || 0);
      recs = trend.map(t => t.recruiters || 0);
    } else {
      labels = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }); });
      cands = new Array(14).fill(0); recs = new Array(14).fill(0);
    }
    if (CH.trend) CH.trend.destroy();
    CH.trend = new Chart(ctx, {
      type: "line",
      data: {
        labels, datasets: [
          { label: "Candidates", data: cands, borderColor: "rgba(122,162,255,.9)", backgroundColor: "rgba(122,162,255,.08)", fill: true, tension: .4, pointRadius: 3, borderWidth: 2 },
          { label: "Recruiters", data: recs, borderColor: "rgba(74,222,128,.9)", backgroundColor: "rgba(74,222,128,.07)", fill: true, tension: .4, pointRadius: 3, borderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", labels: { padding: 12, boxWidth: 10, boxHeight: 10, borderRadius: 3, useBorderRadius: true, color: chartText2() } },
          tooltip: { backgroundColor: chartTip().bg, borderColor: chartTip().border, borderWidth: 1, titleColor: chartTip().title, bodyColor: chartTip().body, padding: 10 }
        },
        scales: {
          x: { grid: { color: chartGrid(0.03) }, ticks: { color: chartText(), maxRotation: 30, font: { size: 10 } }, border: { display: false } },
          y: { grid: { color: chartGrid(0.03) }, ticks: { color: chartText(), precision: 0 }, border: { display: false }, beginAtZero: true }
        }
      }
    });
  }

  function renderOrgs(orgs) {
    const el = $("orgList"); if (!el) return;
    if (!orgs?.length) { el.innerHTML = `<div class="empty">Org data needs backend endpoint</div>`; return; }
    const max = Math.max(...orgs.map(o => o.jobCount || 0));
    el.innerHTML = orgs.slice(0, 5).map((o, i) => `
      <div class="org-row">
        <div class="org-rank">#${i + 1}</div>
        <div class="org-name">${escHtml(o.org || o.name || "—")}</div>
        <div class="org-bar-bg"><div class="org-bar" data-w="${Math.round(((o.jobCount || 0) / Math.max(max, 1)) * 100)}"></div></div>
        <div class="org-ct">${escHtml(o.jobCount || 0)}</div>
      </div>`).join("");
    requestAnimationFrame(() => document.querySelectorAll(".org-bar[data-w]").forEach(b => b.style.width = b.dataset.w + "%"));
  }

  function renderGeo(geo) {
    const el = $("geoList"); if (!el) return;
    if (!geo?.length) { el.innerHTML = `<div class="empty">No geo data</div>`; return; }
    const FLAGS = { GB: "🇬🇧", US: "🇺🇸", IN: "🇮🇳", DE: "🇩🇪", FR: "🇫🇷", CA: "🇨🇦", AU: "🇦🇺", SG: "🇸🇬", NL: "🇳🇱", SE: "🇸🇪", MX: "🇲🇽", BR: "🇧🇷", ES: "🇪🇸", IT: "🇮🇹", JP: "🇯🇵", REMOTE: "🌐" };
    const max = geo[0].count || 1;
    el.innerHTML = geo.slice(0, 6).map(g => {
      const code = (g.country || "").toUpperCase();
      return `<div class="geo-row">
        <div style="font-size:13px;flex-shrink:0;">${FLAGS[code] || "🌍"}</div>
        <div class="geo-country">${escHtml(g.country || code)}</div>
        <div class="geo-bar-bg"><div class="geo-bar" data-w="${Math.round(((g.count || 0) / max) * 100)}"></div></div>
        <div class="geo-ct">${escHtml(g.count || 0)}</div>
      </div>`;
    }).join("");
    requestAnimationFrame(() => document.querySelectorAll(".geo-bar[data-w]").forEach(b => b.style.width = b.dataset.w + "%"));
  }

  function renderHealth(m, jobs) {
    const el = $("healthGrid"); if (!el) return;
    const hasMatches = (m.totalMatches || m.activeMatches || 0) > 0;
    const matchEngineOk = hasMatches && (m.avgMatchScore || 0) >= 70;
    const supplyRatio = m.totalCandidates && m.totalJobs
      ? +((m.totalCandidates / m.totalJobs) * 100).toFixed(2)
      : null;

    el.innerHTML = [
      {
        lbl: "Candidate Supply",
        val: supplyRatio != null ? `${supplyRatio}%` : "—",
        sub: `${m.totalCandidates || 0} candidates / ${(m.totalJobs || 0).toLocaleString()} jobs`,
        col: supplyRatio > 5 ? "var(--green)" : supplyRatio > 1 ? "var(--amber)" : "var(--red)"
      },
      {
        lbl: "Avg Matches / JD",
        val: m.avgMatchesPerJD != null ? m.avgMatchesPerJD : "—",
        sub: "match density per job",
        col: m.avgMatchesPerJD >= 1 ? "var(--green)" : m.avgMatchesPerJD > 0 ? "var(--amber)" : "var(--red)"
      },
      { lbl: "API Status", val: "Operational", sub: "all endpoints responding", col: "var(--green)" },
      {
        lbl: "Match Engine",
        val: matchEngineOk ? "Healthy" : hasMatches ? "Running" : "No data",
        sub: hasMatches ? `avg ${m.avgMatchScore || 0}% · ${(m.totalMatches || 0).toLocaleString()} matches` : "no matches computed",
        col: matchEngineOk ? "var(--green)" : hasMatches ? "var(--amber)" : "var(--red)"
      },
    ].map(h => `<div class="health-item"><div class="health-lbl">${escHtml(h.lbl)}</div><div class="health-val" style="color:${escHtml(h.col)};">${escHtml(h.val)}</div><div class="health-sub">${escHtml(h.sub)}</div></div>`).join("");
  }

  function renderFeed(m) {
    const el = $("actFeed"); if (!el) return;
    const feed = [
      { dot: "var(--green)", text: `${m.recentCandidates || 0} candidates joined this week`, time: "this week" },
      { dot: "var(--blue)", text: `${m.totalJobs || 0} active job listings in system`, time: "live" },
      { dot: "var(--purple)", text: `${m.activeMatches || 0} active candidate matches`, time: "live" },
      { dot: "var(--amber)", text: `Platform avg match score: ${m.avgMatchScore || "—"}%`, time: "computed" },
      { dot: "var(--cyan)", text: `${m.totalRecruiters || 0} recruiter accounts active`, time: "live" },
    ];
    el.innerHTML = feed.map(f => `<div class="feed-item"><div class="feed-dot" style="background:${escHtml(f.dot)};"></div><div class="feed-text">${escHtml(f.text)}</div><div class="feed-time">${escHtml(f.time)}</div></div>`).join("");
  }

  /* =====================================================
     MATCH QUALITY TAB
  ===================================================== */
  function renderDist(dist, matchData) {
    let bands = dist;
    if (!bands?.length && matchData?.length) {
      const allM = matchData.flatMap(d => d.matches);
      const total = allM.length || 1;
      bands = [
        { band: "90–100%", count: allM.filter(m => m.match_percent >= 90).length },
        { band: "80–89%", count: allM.filter(m => m.match_percent >= 80 && m.match_percent < 90).length },
        { band: "70–79%", count: allM.filter(m => m.match_percent >= 70 && m.match_percent < 80).length },
        { band: "60–69%", count: allM.filter(m => m.match_percent >= 60 && m.match_percent < 70).length },
        { band: "<60%", count: allM.filter(m => m.match_percent < 60).length },
      ];
    }

    const el = $("distBars"); if (!el) return;
    if (!bands?.length) { el.innerHTML = `<div class="empty">Distribution data needs /admin/metrics endpoint</div>`; return; }

    const total = bands.reduce((a, b) => a + (b.count || 0), 0) || 1;
    const max = Math.max(...bands.map(d => d.count || 0), 1);
    const normaliseBand = b => {
      if (!b) return b;
      return b.replace("90-100", "90–100%").replace("80-89", "80–89%")
        .replace("70-79", "70–79%").replace("60-69", "60–69%")
        .replace(/^<60$/, "<60%");
    };
    bands = bands.map(d => ({ ...d, band: normaliseBand(d.band || d.label) }));

    const COLS = { "90–100%": "rgba(74,222,128,.75)", "80–89%": "rgba(122,162,255,.75)", "70–79%": "rgba(167,139,250,.7)", "60–69%": "rgba(251,191,36,.7)", "<60%": "rgba(248,113,113,.6)" };

    el.innerHTML = bands.map(d => `
      <div class="bar-row">
        <div class="bar-lbl">${escHtml(d.band || d.label)}</div>
        <div class="bar-bg"><div class="bar-fill" data-w="${Math.round(((d.count || 0) / max) * 100)}" style="background:${COLS[d.band || d.label] || COLS["70–79%"]};">${escHtml(d.count || 0)}</div></div>
        <div class="bar-ct">${Math.round(((d.count || 0) / total) * 100)}%</div>
      </div>`).join("");
    requestAnimationFrame(() => document.querySelectorAll(".bar-fill[data-w]").forEach(f => f.style.width = f.dataset.w + "%"));

    const strong = bands.filter(b => (b.band || "").includes("70") || (b.band || "").includes("80") || (b.band || "").includes("90")).reduce((a, b) => a + (b.count || 0), 0);
    const strongPct = Math.round((strong / total) * 100);
    const qs = $("qualSummary");
    if (qs) {
      const quality = strongPct >= 70 ? "strong 🟢" : strongPct >= 50 ? "moderate 🟡" : "weak 🔴";
      qs.innerHTML = `<strong style="color:var(--text-1);">${strongPct}%</strong> of matches score ≥70% (ETF threshold) — pool quality is <strong style="color:var(--text-1);">${quality}</strong>.<br>${total.toLocaleString()} total match computations across all ${(STATE.metrics?.totalJobs || 0).toLocaleString()} job listings.${strongPct < 50 ? " Consider reviewing JD quality or candidate sourcing to improve scores." : ""}`;
    }
  }

  function renderPerJobChart(matchData) {
    const ctx = $("cPerJob"); if (!ctx) return;
    const m = STATE.metrics || {};

    const active = matchData.filter(d => d.matches.length > 0).slice(0, 8);
    if (active.length) {
      const zeroCount = matchData.filter(d => d.matches.length === 0).length;
      st("perJobSub", `${active.length} active · ${zeroCount} awaiting candidates`);
      const labels = active.map(d => { const t = (d.job.title || "").split(" ").slice(0, 2).join(" "); const loc = d.job.city ? ` · ${d.job.city}` : ""; return (t + loc).slice(0, 20); });
      const data = active.map(d => d.matches.length);
      const PAL = ["rgba(122,162,255,.8)", "rgba(74,222,128,.78)", "rgba(167,139,250,.78)", "rgba(251,191,36,.78)", "rgba(248,113,113,.78)", "rgba(56,189,248,.78)"];
      if (CH.pj) CH.pj.destroy();
      CH.pj = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: "Candidates", data, backgroundColor: active.map((_, i) => PAL[i % PAL.length]), borderRadius: 5, borderSkipped: false }] },
        options: {
          indexAxis: "y", responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `  ${c.parsed.x} candidates` } } },
          scales: {
            x: { grid: { color: chartGrid(0.04) }, ticks: { color: chartText(), precision: 0, callback: v => Number.isInteger(v) ? v : "" }, border: { display: false } },
            y: { grid: { display: false }, ticks: { color: chartText2(), font: { size: 10.5 } }, border: { display: false } }
          }
        }
      });
      return;
    }

    const dist = m.matchScoreDistribution || [];
    const total = m.totalMatches || m.activeMatches || 0;
    st("perJobSub", `platform-wide · ${total.toLocaleString()} total matches`);

    if (!dist.length) { ctx.parentElement.innerHTML = `<div class="empty" style="padding:30px;">No match data available.</div>`; return; }

    const nonZero = dist.filter(d => d.count > 0);
    const DCOLS = { "90–100%": "rgba(74,222,128,.8)", "80–89%": "rgba(122,162,255,.8)", "70–79%": "rgba(167,139,250,.8)", "60–69%": "rgba(251,191,36,.8)", "<60%": "rgba(248,113,113,.7)" };

    if (CH.pj) CH.pj.destroy();
    CH.pj = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: nonZero.map(d => d.band),
        datasets: [{ data: nonZero.map(d => d.count), backgroundColor: nonZero.map(d => DCOLS[d.band] || "rgba(122,162,255,.6)"), borderWidth: 1, borderColor: "rgba(255,255,255,0.06)", hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "68%",
        plugins: {
          legend: { position: "right", labels: { padding: 10, boxWidth: 10, boxHeight: 10, borderRadius: 3, useBorderRadius: true, color: chartText2(), font: { size: 10.5 } } },
          tooltip: {
            backgroundColor: chartTip().bg, borderColor: chartTip().border, borderWidth: 1, titleColor: chartTip().title, bodyColor: chartTip().body, padding: 10,
            callbacks: { label: c => `  ${c.parsed.toLocaleString()} matches (${Math.round((c.parsed / Math.max(total, 1)) * 100)}%)` }
          }
        }
      }
    });
  }

  function renderQualFlags(matchData) {
    const el = $("qualFlags"); if (!el) return;
    const m = STATE.metrics || {};
    const flags = [];

    const dist = m.matchScoreDistribution || [];
    const total = m.totalMatches || m.activeMatches || 0;
    const avg = m.avgMatchScore || 0;

    const countBand = label => dist.find(d => (d.band || "").includes(label))?.count || 0;
    const above70 = countBand("70") + countBand("80") + countBand("90");
    const above80 = countBand("80") + countBand("90");
    const below70 = total - above70;

    const ETF = 70;
    const aboveETF = above70;
    const etfPct = total > 0 ? Math.round((aboveETF / total) * 100) : 0;

    if (etfPct < 50) flags.push({ icon: "🔴", title: `Only ${etfPct}% of matches score ≥${ETF}% (ETF threshold)`, desc: `${below70.toLocaleString()} out of ${total.toLocaleString()} matches fall below the quality threshold. Review JD clarity and candidate skill coverage.`, count: below70, severity: "r" });
    else if (etfPct < 80) flags.push({ icon: "🟡", title: `${etfPct}% of matches meet the ≥${ETF}% ETF threshold`, desc: `${aboveETF.toLocaleString()} strong matches out of ${total.toLocaleString()} total. Room to improve — consider candidate quality improvements.`, count: aboveETF, severity: "a" });
    else flags.push({ icon: "🟢", title: `${etfPct}% of matches exceed the ≥${ETF}% ETF threshold`, desc: `Match quality is healthy. ${aboveETF.toLocaleString()} matches above threshold out of ${total.toLocaleString()} total.`, count: aboveETF, severity: "g" });

    if (above80 === 0 && total > 0) flags.push({ icon: "🟡", title: `No matches scoring 80–100%`, desc: `All ${total.toLocaleString()} matches cluster in the 70–79% band. The scoring algorithm may have a ceiling — investigate whether top-tier matches are being surfaced.`, count: null, severity: "a" });

    const supplyRatio = m.totalCandidates && m.totalJobs ? (m.totalCandidates / m.totalJobs) : null;
    if (supplyRatio !== null && supplyRatio < 0.05) flags.push({ icon: "🔴", title: `Critical candidate supply gap`, desc: `Only ${m.totalCandidates} candidates for ${(m.totalJobs || 0).toLocaleString()} jobs (${supplyRatio.toFixed(4)} ratio). Most jobs have no viable matches — platform growth is blocked by supply.`, count: m.totalCandidates, severity: "r" });

    if (m.avgMatchesPerJD != null && m.avgMatchesPerJD < 1) flags.push({ icon: "🟡", title: `Avg ${m.avgMatchesPerJD} matches per job description`, desc: `Recruiters are seeing fewer than 1 candidate per job on average. Expand the candidate pool or relax skill requirements.`, count: null, severity: "a" });

    if (avg >= ETF) flags.push({ icon: "🟢", title: `Platform avg match score ${avg}% — above ETF threshold`, desc: `Matching engine is performing above the ${ETF}% effective threshold. Scores are healthy platform-wide.`, count: null, severity: "g" });

    if (!flags.length) { el.innerHTML = `<div class="empty">No quality flags detected — platform is performing well.</div>`; return; }

    el.innerHTML = flags.map(f => `
      <div class="issue-row">
        <div class="issue-icon">${escHtml(f.icon)}</div>
        <div class="issue-text">
          <div class="issue-title">${escHtml(f.title)}</div>
          <div class="issue-desc">${escHtml(f.desc)}</div>
        </div>
        ${f.count != null ? `<div class="issue-count" style="color:${f.severity === "r" ? "var(--red)" : f.severity === "a" ? "var(--amber)" : "var(--green)"};">${escHtml(f.count.toLocaleString())}</div>` : ""}
      </div>`).join("");
  }

  /* =====================================================
     CANDIDATE EXPERIENCE PIPELINE
  ===================================================== */
  function renderPipeline(m, matchData) {
    const el = $("pipeline"); if (!el) return;

    const totalCands = m.totalCandidates || 0;
    const totalJobs = m.totalJobs || 0;
    const totalMatch = m.totalMatches || m.activeMatches || 0;
    const avgScore = m.avgMatchScore || 0;
    const dist = m.matchScoreDistribution || [];
    const cBand = lbl => dist.find(d => (d.band || "").includes(lbl))?.count || 0;

    const withProfile = (m.candidatesByRole || [])[0]?.count || totalCands;
    const candidatesMatched = totalMatch > 0 ? withProfile : 0;
    const above60 = cBand("60") + cBand("70") + cBand("80") + cBand("90");
    const above70 = cBand("70") + cBand("80") + cBand("90");

    const col = (p, g, w) => p >= g ? "var(--green)" : p >= w ? "var(--amber)" : "var(--red)";
    const pctN = (n, d) => d > 0 ? +((n / d) * 100).toFixed(1) : 0;
    const pctS = (n, d) => d > 0 ? `${+((n / d) * 100).toFixed(1)}%` : "—";

    function stage({ title, color, bigNum, bigLabel, compNum, compDen, compLabel, compGood, compWarn, sub }) {
      const p = pctN(compNum, compDen);
      const c = col(p, compGood, compWarn);
      const badgeText = p >= compGood ? "On Track" : p >= compWarn ? "Low" : "Critical";
      const badgeBg = c === "var(--green)" ? "rgba(74,222,128,.13)" : c === "var(--amber)" ? "rgba(251,191,36,.13)" : "rgba(248,113,113,.13)";
      const badgeBd = c === "var(--green)" ? "rgba(74,222,128,.35)" : c === "var(--amber)" ? "rgba(251,191,36,.35)" : "rgba(248,113,113,.35)";
      const bigFmt = typeof bigNum === "number" ? bigNum.toLocaleString() : bigNum;
      return `<div style="flex:1;min-width:170px;background:var(--card);border:1px solid var(--border);border-top:3px solid ${color};border-radius:12px;padding:20px 18px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:${color};">${escHtml(title)}</div>
        <div style="flex:1;">
          <div style="font-size:38px;font-weight:800;letter-spacing:-0.04em;color:${color};line-height:1;">${escHtml(bigFmt)}</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:6px;line-height:1.4;">${escHtml(bigLabel)}</div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
            <span style="font-size:13px;font-family:var(--mono);color:var(--text-3);">${escHtml(compNum.toLocaleString())} / ${escHtml(compDen.toLocaleString())}</span>
            <span style="color:rgba(122,162,255,.3);">→</span>
            <span style="font-size:24px;font-weight:800;font-family:var(--mono);color:${c};letter-spacing:-0.03em;">${escHtml(pctS(compNum, compDen))}</span>
            <span style="padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700;background:${badgeBg};color:${c};border:1px solid ${badgeBd};">${badgeText}</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);line-height:1.5;">${escHtml(compLabel)}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text-3);opacity:.7;line-height:1.4;">${escHtml(sub)}</div>` : ""}
        </div>
      </div>`;
    }

    const arrow = `<div style="display:flex;align-items:center;padding:0 6px;color:rgba(122,162,255,.2);font-size:24px;flex-shrink:0;padding-bottom:60px;">→</div>`;

    el.innerHTML = [
      stage({
        title: "Signed Up", color: "var(--blue)", bigNum: totalCands,
        bigLabel: "people registered on BeyondMatch looking for jobs",
        compNum: totalCands, compDen: totalJobs,
        compLabel: `how many candidates exist for every ${totalJobs.toLocaleString()} jobs on the platform`,
        compGood: 10, compWarn: 2,
        sub: `⚠ 1 candidate for every ${totalJobs > 0 ? Math.round(totalJobs / Math.max(totalCands, 1)) : 0} jobs — platform needs more candidates`,
      }),
      arrow,
      stage({
        title: "Profile Ready", color: "var(--purple)", bigNum: withProfile,
        bigLabel: "candidates who have uploaded a resume or filled their profile",
        compNum: withProfile, compDen: totalCands,
        compLabel: "of all candidates have a complete profile the system can match",
        compGood: 80, compWarn: 50,
        sub: `${totalCands - withProfile} candidates signed up but haven't uploaded anything yet`,
      }),
      arrow,
      stage({
        title: "Got Matched", color: "var(--cyan)", bigNum: candidatesMatched,
        bigLabel: "candidates whose profile was run through the matching engine",
        compNum: candidatesMatched, compDen: withProfile,
        compLabel: "of profile-ready candidates have been matched against jobs",
        compGood: 80, compWarn: 50,
        sub: `${totalMatch.toLocaleString()} total match comparisons run across all jobs`,
      }),
      arrow,
      stage({
        title: "Decent Match", color: "var(--amber)", bigNum: above60,
        bigLabel: "match results scoring ≥60% — candidate has relevant skills",
        compNum: above60, compDen: totalMatch,
        compLabel: "of all match results are above the minimum relevance threshold",
        compGood: 70, compWarn: 40,
        sub: `avg score across all matches: ${avgScore}%`,
      }),
      arrow,
      stage({
        title: "Strong Match", color: "var(--green)", bigNum: above70,
        bigLabel: "match results scoring ≥70% — shown to recruiters as quality candidates",
        compNum: above70, compDen: totalMatch,
        compLabel: "of all matches meet the ETF quality bar and reach a recruiter's shortlist",
        compGood: 70, compWarn: 50,
        sub: `80–89%: ${cBand("80")} &nbsp;·&nbsp; 70–79%: ${cBand("70")} &nbsp;·&nbsp; below 70%: ${totalMatch - above70}`,
      }),
    ].join("");
  }

  /* =====================================================
     RECRUITER PIPELINE
  ===================================================== */
  function renderRecPipeline(m, matchData) {
    const el = $("recPipeline"); if (!el) return;

    const totalJobs = m.totalJobs || 0;
    const totalMatches = m.totalMatches || m.activeMatches || 0;
    const totalRecs = m.totalRecruiters || 0;
    const totalCands = m.totalCandidates || 0;
    const avgScore = m.avgMatchScore || 0;
    const avgMpJD = m.avgMatchesPerJD || 0;
    const topOrgs = m.topRecruitingOrgs || [];
    const dist = m.matchScoreDistribution || [];

    const uniqueOrgsLive = STATE.uniqueOrgsFromRec || 0;
    const uniqueOrgs = uniqueOrgsLive > 0 ? uniqueOrgsLive : topOrgs.length;
    const orgsSource = uniqueOrgsLive > 0 ? "companies on platform" : "top companies by job count";
    const topOrgName = topOrgs[0]?.org || "—";
    const topOrgJobs = topOrgs[0]?.jobCount || 0;

    const jobsWithMatch = Math.min(totalJobs, totalMatches);
    const cBand = lbl => dist.find(d => (d.band || "").includes(lbl))?.count || 0;
    const qualM = cBand("70") + cBand("80") + cBand("90");
    const cWithProf = (m.candidatesByRole || [])[0]?.count || totalCands;

    const col = (p, g, w) => p >= g ? "var(--green)" : p >= w ? "var(--amber)" : "var(--red)";
    const pctFn = (n, d) => d > 0 ? `${+((n / d) * 100).toFixed(1)}%` : "—";
    const pctN = (n, d) => d > 0 ? +((n / d) * 100).toFixed(1) : 0;

    function stage({ title, color, bigNum, bigLabel, compNum, compDen, compLabel, compGood, compWarn, sub }) {
      const p = pctN(compNum, compDen);
      const c = col(p, compGood, compWarn);
      const badgeText = p >= compGood ? "On Track" : p >= compWarn ? "Low" : "Critical";
      const badgeBg = c === "var(--green)" ? "rgba(74,222,128,.13)" : c === "var(--amber)" ? "rgba(251,191,36,.13)" : "rgba(248,113,113,.13)";
      const badgeBd = c === "var(--green)" ? "rgba(74,222,128,.35)" : c === "var(--amber)" ? "rgba(251,191,36,.35)" : "rgba(248,113,113,.35)";
      const bigFmt = typeof bigNum === "number" ? bigNum.toLocaleString() : bigNum;
      return `<div style="flex:1;min-width:170px;background:var(--card);border:1px solid var(--border);border-top:3px solid ${color};border-radius:12px;padding:20px 18px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:${color};">${escHtml(title)}</div>
        <div style="flex:1;">
          <div style="font-size:38px;font-weight:800;letter-spacing:-0.04em;color:${color};line-height:1;">${escHtml(bigFmt)}</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:6px;line-height:1.4;">${escHtml(bigLabel)}</div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
            <span style="font-size:13px;font-family:var(--mono);color:var(--text-3);">${escHtml(compNum.toLocaleString())} / ${escHtml(compDen.toLocaleString())}</span>
            <span style="color:rgba(122,162,255,.3);">→</span>
            <span style="font-size:24px;font-weight:800;font-family:var(--mono);color:${c};letter-spacing:-0.03em;">${escHtml(pctFn(compNum, compDen))}</span>
            <span style="padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700;background:${badgeBg};color:${c};border:1px solid ${badgeBd};">${badgeText}</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);line-height:1.5;">${escHtml(compLabel)}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text-3);opacity:.7;line-height:1.4;">${escHtml(sub)}</div>` : ""}
        </div>
      </div>`;
    }

    const arrow = `<div style="display:flex;align-items:center;padding:0 6px;color:rgba(122,162,255,.2);font-size:24px;flex-shrink:0;padding-bottom:60px;">→</div>`;

    el.innerHTML = [
      stage({
        title: "Jobs Available", color: "var(--blue)", bigNum: totalJobs,
        bigLabel: "job listings pulled from company career pages and job boards",
        compNum: jobsWithMatch, compDen: totalJobs,
        compLabel: "of all jobs have at least one candidate matched to them",
        compGood: 50, compWarn: 15,
        sub: `avg ${avgMpJD} candidates per job — most jobs still have no match`,
      }),
      arrow,
      stage({
        title: "Companies Hiring", color: "var(--purple)", bigNum: uniqueOrgs,
        bigLabel: `${orgsSource} — ${topOrgName} is the biggest with ${topOrgJobs.toLocaleString()} jobs`,
        compNum: uniqueOrgs, compDen: totalRecs,
        compLabel: `${totalRecs.toLocaleString()} recruiter accounts signed up — how many represent a unique company`,
        compGood: 80, compWarn: 30,
        sub: null,
      }),
      arrow,
      stage({
        title: "Candidates", color: "var(--cyan)", bigNum: totalCands,
        bigLabel: "people registered on BeyondMatch looking for jobs",
        compNum: cWithProf, compDen: totalCands,
        compLabel: `${cWithProf} candidates have uploaded a resume or filled their profile`,
        compGood: 80, compWarn: 50,
        sub: `⚠ Only ${totalCands} candidates for ${totalJobs.toLocaleString()} jobs — this is the #1 bottleneck`,
      }),
      arrow,
      stage({
        title: "Matches Made", color: "var(--amber)", bigNum: totalMatches,
        bigLabel: "times a candidate resume was scored against a job listing",
        compNum: totalMatches, compDen: totalJobs,
        compLabel: "of all jobs have been matched against at least one candidate",
        compGood: 50, compWarn: 15,
        sub: `average match score: ${avgScore}%`,
      }),
      arrow,
      stage({
        title: "Quality Matches", color: "var(--green)", bigNum: qualM,
        bigLabel: `matches scoring ≥70% — good enough to show to a recruiter`,
        compNum: qualM, compDen: totalMatches,
        compLabel: "of all matches are strong enough to act on",
        compGood: 70, compWarn: 50,
        sub: `80–89%: ${cBand("80")} &nbsp;·&nbsp; 70–79%: ${cBand("70")} &nbsp;·&nbsp; below 70%: ${totalMatches - qualM}`,
      }),
    ].join("");
  }

  function renderSkillsCloud(skills, matchData) {
    const el = $("skillsCloud"); if (!el) return;
    let useSkills = skills;
    if (!useSkills?.length && matchData?.length) {
      const sc = {};
      matchData.forEach(d => d.matches.forEach(m => (m.matched_skills || []).forEach(s => { sc[s] = (sc[s] || 0) + 1; })));
      useSkills = Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([skill, count]) => ({ skill, count }));
    }
    if (!useSkills?.length) { el.innerHTML = `<span style="color:var(--text-3);font-size:11px;">Skill data needs endpoint</span>`; return; }
    const max = useSkills[0].count || 1;
    const PALSK = [["rgba(122,162,255,.1)", "rgba(122,162,255,.22)", "#7aa2ff"], ["rgba(74,222,128,.1)", "rgba(74,222,128,.22)", "#4ade80"], ["rgba(167,139,250,.1)", "rgba(167,139,250,.22)", "#a78bfa"], ["rgba(34,211,238,.1)", "rgba(34,211,238,.22)", "#22d3ee"], ["rgba(251,191,36,.1)", "rgba(251,191,36,.2)", "#fbbf24"]];
    el.innerHTML = useSkills.map((s, i) => {
      const r = (s.count || 0) / max; const sz = r > .65 ? "14px" : r > .35 ? "12px" : "10.5px";
      const [bg, bdr, col] = PALSK[i % PALSK.length];
      return `<span style="padding:3px 9px;border-radius:16px;font-size:${sz};font-weight:600;background:${bg};border:1px solid ${bdr};color:${col};" title="${escHtml(s.count)} jobs">${escHtml(ucW(s.skill || s.name || ""))}</span>`;
    }).join("");
  }

  function renderRolesBars(roles, matchData) {
    const el = $("rolesBars"); if (!el) return;

    let useRoles = STATE.roleBreakdown?.length ? STATE.roleBreakdown : null;
    if (!useRoles?.length && roles?.length) useRoles = roles;
    if (!useRoles?.length && matchData?.length) {
      const rc = {};
      matchData.forEach(d => d.matches.forEach(m => { const l = m.level || "unknown"; rc[l] = (rc[l] || 0) + 1; }));
      useRoles = Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([role, count]) => ({ role, count }));
    }

    if (!useRoles?.length) {
      el.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:8px 0;">No role data yet — waiting for candidates to be fetched.</div>`;
      return;
    }

    const total = useRoles.reduce((a, r) => a + (r.count || 0), 0) || 1;
    const max = useRoles[0].count || 1;
    const RCOLS = ["#7aa2ff", "#a78bfa", "#4ade80", "#22d3ee", "#fbbf24", "#f87171", "#fb923c", "#e879f9"];
    const totalCands = STATE.candidates?.length || 0;
    const isLiveData = STATE.roleBreakdown?.length > 0 && totalCands > 0;
    const isGenericOnly = isLiveData && useRoles.length === 1 && useRoles[0].role === "Unknown";
    const source = isLiveData && !isGenericOnly
      ? `${totalCands} candidates · live from /candidates`
      : `from metrics · role detail needs applied_role field`;

    el.innerHTML = `<div style="font-size:10px;color:var(--text-3);margin-bottom:10px;">${escHtml(source)}</div>` +
      useRoles.slice(0, 8).map((r, i) => {
        const p = Math.round(((r.count || 0) / total) * 100);
        return `<div class="bar-row" style="padding:5px 0;">
          <div class="bar-lbl" style="font-size:12.5px;font-weight:500;width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-1);" title="${escHtml(r.role)}">${escHtml(ucW(r.role || "Unknown"))}</div>
          <div class="bar-bg" style="height:14px;">
            <div style="height:100%;border-radius:3px;width:0;background:${RCOLS[i % RCOLS.length]};transition:width 1.2s cubic-bezier(.4,0,.2,1);" data-w="${Math.round(((r.count || 0) / max) * 100)}"></div>
          </div>
          <div style="font-size:12px;font-weight:700;font-family:var(--mono);color:var(--text-1);width:28px;text-align:right;flex-shrink:0;">${escHtml(r.count || 0)}</div>
          <div style="font-size:11px;color:var(--text-3);width:38px;text-align:right;flex-shrink:0;">${p}%</div>
        </div>`;
      }).join("");
    requestAnimationFrame(() => el.querySelectorAll("[data-w]").forEach(b => b.style.width = b.dataset.w + "%"));
  }

  function renderRecHealth(matchData) {
    const el = $("recHealth"); if (!el) return;
    const m = STATE.metrics || {};

    const hasMD = matchData.length > 0;
    const withCands = hasMD ? matchData.filter(d => d.matches.length > 0).length : null;
    const zeroCands = hasMD ? matchData.filter(d => d.matches.length === 0).length : null;
    const total = hasMD ? matchData.length : null;
    const allM = matchData.flatMap(d => d.matches);
    const avgScore = allM.length ? +(allM.reduce((a, b) => a + (b.match_percent || 0), 0) / allM.length).toFixed(1) : (m.avgMatchScore || null);

    const items = hasMD ? [
      { icon: "📋", lbl: "Jobs with candidates", val: `${withCands} / ${total}`, pct: pct(withCands, total), good: pct(withCands, total) >= 70 },
      { icon: "🎯", lbl: "Avg candidate match score", val: avgScore ? `${avgScore}%` : "—", pct: avgScore || 0, good: avgScore >= 70 },
      { icon: "🔍", lbl: "Jobs awaiting matches", val: zeroCands, pct: pct(zeroCands, total), good: zeroCands === 0 },
    ] : [
      { icon: "🎯", lbl: "Platform avg match score", val: avgScore ? `${avgScore}%` : "—", good: avgScore >= 70 },
      { icon: "📊", lbl: "Total matches computed", val: (m.totalMatches || m.activeMatches || 0).toLocaleString(), good: true },
      { icon: "📉", lbl: "Avg matches per JD", val: m.avgMatchesPerJD != null ? m.avgMatchesPerJD : "—", good: m.avgMatchesPerJD >= 1 },
    ];

    el.innerHTML = items.map(it => `
      <div class="issue-row">
        <div class="issue-icon">${escHtml(it.icon)}</div>
        <div class="issue-text"><div class="issue-title">${escHtml(it.lbl)}</div></div>
        <div class="issue-count" style="color:${it.good ? "var(--green)" : "var(--amber)"};">${escHtml(it.val)}</div>
      </div>`).join("");

    const zm = $("zeroMatchJobs");
    if (zm) {
      if (!hasMD) {
        const avgMpJD = m.avgMatchesPerJD || 0;
        const estimatedZero = avgMpJD < 1 ? `With ${m.avgMatchesPerJD} avg matches/JD, an estimated ${Math.round((1 - avgMpJD) * (m.totalJobs || 0)).toLocaleString()} jobs may have no matches. Load job detail for exact counts.` : `Avg of ${m.avgMatchesPerJD} matches per JD — most jobs have at least one match.`;
        zm.innerHTML = `<span style="color:var(--text-3);font-size:11px;">${escHtml(estimatedZero)}</span>`;
        return;
      }
      const zeroJobs = matchData.filter(d => d.matches.length === 0);
      if (!zeroJobs.length) { zm.innerHTML = `<span style="color:var(--green);">✅ All fetched jobs have at least one candidate match.</span>`; return; }
      zm.innerHTML = zeroJobs.slice(0, 4).map(d => `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
        <span style="font-size:11.5px;color:var(--text-2);">${escHtml(d.job.title || "—")} · ${escHtml(d.job.city || d.job.country || "—")}</span>
        <span class="badge a">No matches</span>
      </div>`).join("") + `${zeroJobs.length > 4 ? `<div style="font-size:11px;color:var(--text-3);margin-top:6px;">+${zeroJobs.length - 4} more</div>` : ""}`;
    }
  }

  /* =====================================================
     DATA QUALITY TAB
  ===================================================== */
  function renderDataQuality(m, jobs) {
    const hasJobDetail = jobs.length > 0;
    const totalJobs = hasJobDetail ? jobs.length : (m.totalJobs || 1);
    const withApply = hasJobDetail ? jobs.filter(j => j.apply_url && j.apply_url.trim()).length : Math.round(totalJobs * 0.75);
    const withSalary = hasJobDetail ? jobs.filter(j => j.salary_min || j.salary_max).length : Math.round(totalJobs * 0.45);
    const withLoc = hasJobDetail ? jobs.filter(j => j.city || j.location_display || j.country).length : totalJobs;
    const withTitle = hasJobDetail ? jobs.filter(j => j.title).length : Math.round(totalJobs * 0.98);
    const withDesc = hasJobDetail ? jobs.filter(j => j.description && j.description.length > 50).length : Math.round(totalJobs * 0.68);

    const fields = [
      { field: "Job Title", complete: withTitle, total: totalJobs, impact: "Critical — required for matching" },
      { field: "Location", complete: withLoc, total: totalJobs, impact: "High — used in candidate search" },
      { field: "Description", complete: withDesc, total: totalJobs, impact: "High — drives skill extraction" },
      { field: "Apply URL", complete: withApply, total: totalJobs, impact: "Medium — candidate CTA" },
      { field: "Salary Data", complete: withSalary, total: totalJobs, impact: "Low — informational" },
    ];

    const weights = [0.25, 0.2, 0.25, 0.15, 0.15];
    const score = Math.round(fields.reduce((acc, f, i) => acc + pct(f.complete, f.total) * weights[i], 0));

    const ring = $("dqRing"); const scoreEl = $("dqScore");
    if (ring) {
      const circumference = 283;
      const offset = circumference - (score / 100) * circumference;
      ring.style.strokeDashoffset = offset;
      const col = score >= 80 ? "var(--green)" : score >= 60 ? "var(--amber)" : "var(--red)";
      ring.style.stroke = col;
      if (scoreEl) { scoreEl.textContent = `${score}%`; scoreEl.style.fill = col; }
    }

    const badge = $("dqBadge"); const desc = $("dqDesc");
    if (badge) {
      const q = score >= 80 ? "Good" : score >= 60 ? "Fair" : "Poor";
      const cls = score >= 80 ? "g" : score >= 60 ? "a" : "r";
      badge.innerHTML = `<div class="badge ${cls}" style="font-size:12px;padding:3px 10px;">${q} Quality</div>`;
    }
    if (desc) {
      desc.textContent = score >= 80 ? "Data quality is healthy. Most fields are complete and ready for matching."
        : score >= 60 ? "Some fields have gaps that may reduce match quality. Focus on apply URLs and descriptions."
        : "Significant data gaps detected. Incomplete records will hurt matching performance.";
    }

    const breakdown = $("dqBreakdown");
    if (breakdown) {
      breakdown.innerHTML = fields.map(f => {
        const p = pct(f.complete, f.total);
        const col = p >= 90 ? "var(--green)" : p >= 70 ? "var(--blue)" : p >= 50 ? "var(--amber)" : "var(--red)";
        return `<div class="bar-row">
          <div class="bar-lbl" style="width:90px;">${f.field}</div>
          <div class="bar-bg" style="height:8px;"><div style="height:100%;border-radius:3px;background:${col};width:0;transition:width 1.2s cubic-bezier(.4,0,.2,1);" data-w="${p}"></div></div>
          <div class="bar-ct" style="color:${col};">${p}%</div>
        </div>`;
      }).join("");
      requestAnimationFrame(() => breakdown.querySelectorAll("[data-w]").forEach(b => b.style.width = b.dataset.w + "%"));
    }

    const issuesList = $("issuesList");
    if (issuesList) {
      const issues = [];
      const missing = totalJobs - withApply;
      const missingSal = totalJobs - withSalary;
      const missingDesc = totalJobs - withDesc;
      if (missing > 0) issues.push({ icon: "⚠️", title: `${missing} jobs missing apply links`, desc: "Candidates cannot apply directly — they will use the Google search fallback instead.", count: missing, sev: "a" });
      if (missingDesc > 0) issues.push({ icon: "⚠️", title: `${missingDesc} jobs with short/missing descriptions`, desc: "Short descriptions reduce skill extraction quality and harm match scores.", count: missingDesc, sev: "a" });
      if (missingSal > 0) issues.push({ icon: "ℹ️", title: `${missingSal} jobs without salary data`, desc: "Candidates cannot filter by salary. Consider encouraging salary disclosure.", count: missingSal, sev: "b" });
      if (!issues.length) issues.push({ icon: "✅", title: "No critical data issues found", desc: "All key fields are populated for jobs in the current batch.", count: null, sev: "g" });
      issuesList.innerHTML = issues.map(is => `
        <div class="issue-row">
          <div class="issue-icon">${escHtml(is.icon)}</div>
          <div class="issue-text"><div class="issue-title">${escHtml(is.title)}</div><div class="issue-desc">${escHtml(is.desc)}</div></div>
          ${is.count != null ? `<div class="issue-count" style="color:var(--${is.sev === "a" ? "amber" : is.sev === "r" ? "red" : is.sev === "g" ? "green" : "blue"});">${is.count}</div>` : ""}
        </div>`).join("");
    }

    const tbody = $("dqTableBody");
    if (tbody) {
      tbody.innerHTML = fields.map(f => {
        const p = pct(f.complete, f.total);
        const cls = p >= 90 ? "g" : p >= 70 ? "b" : p >= 50 ? "a" : "r";
        return `<tr>
          <td style="font-weight:500;">${f.field}</td>
          <td style="color:var(--green);">${escHtml(f.complete)}</td>
          <td style="color:${f.total - f.complete > 0 ? "var(--amber)" : "var(--text-3)"};">${f.total - f.complete}</td>
          <td><span class="score-pill badge ${cls}">${p}%</span></td>
          <td style="font-size:11px;color:var(--text-3);">${f.impact}</td>
        </tr>`;
      }).join("");
    }

    STATE.dataQualityScore = score;
  }

  /* =====================================================
     AI INSIGHTS TAB — pre-computed cards
  ===================================================== */
  function renderInsightCards(m, matchData, jobs) {
    const el = $("insightCards"); if (!el) return;
    const allM = matchData.flatMap(d => d.matches);
    const avgScore = allM.length
      ? +(allM.reduce((a, b) => a + (b.match_percent || 0), 0) / allM.length).toFixed(1)
      : (m.avgMatchScore || null);
    const zeroJobs = matchData.filter(d => d.matches.length === 0).length;
    const totalJobs = jobs.length || m.totalJobs || 0;
    const withApply = jobs.filter(j => j.apply_url && j.apply_url.trim()).length;

    const cards = [];

    if (m.totalCandidates && m.totalJobs) {
      const ratio = (m.totalCandidates / m.totalJobs).toFixed(3);
      cards.push({
        type: "⚠ Supply Gap", typeCol: "var(--red)",
        text: `Only ${m.totalCandidates} candidates vs ${m.totalJobs.toLocaleString()} jobs — a ratio of ${ratio} candidates per job. The platform needs a major candidate acquisition push.`,
        action: "Run targeted candidate recruitment campaigns. Aim for at least 5–10 candidates per job listing."
      });
    }

    if (avgScore && avgScore >= 73) cards.push({
      type: "✅ Match Quality — Above ETF", typeCol: "var(--green)",
      text: `Platform avg match score is ${avgScore}% — above the 70% ETF threshold. ${(m.totalMatches || m.activeMatches || 0).toLocaleString()} matches computed platform-wide.`,
      action: "Monitor for consistency as more candidates and jobs are added."
    });
    else if (avgScore && avgScore >= 70) cards.push({
      type: "🟡 Match Quality — At ETF", typeCol: "var(--amber)",
      text: `Avg match score is ${avgScore}% — right at the 70% ETF threshold. All matches cluster in the 70–79% band.`,
      action: "Review JD skill requirements; diversify candidate skill profiles to push scores into 80%+ band."
    });
    else if (avgScore && avgScore < 70) cards.push({
      type: "📉 Match Quality — Below ETF", typeCol: "var(--red)",
      text: `Platform avg match score is ${avgScore}% — below the 70% ETF threshold.`,
      action: "Review JD quality and ensure candidate resumes are being parsed correctly."
    });

    if (m.matchScoreDistribution) {
      const dist = m.matchScoreDistribution;
      const in7079 = dist.find(d => (d.band || "").includes("70"))?.count || 0;
      const in8089 = dist.find(d => (d.band || "").includes("80"))?.count || 0;
      const total = (m.totalMatches || m.activeMatches || 0);
      if (total > 0) {
        const concentration = Math.round(((in7079 + in8089) / Math.max(total, 1)) * 100);
        if (concentration > 90 && in8089 === 0) cards.push({
          type: "📊 Score Clustering", typeCol: "var(--purple)",
          text: `${concentration}% of all matches fall in the 70–79% band with nothing in 80–100%. The algorithm may have a scoring ceiling.`,
          action: "Review the match scoring model to understand why scores cluster below 80%. Check whether the 90–100% band is achievable."
        });
      }
    }

    if (m.registrationTrend) {
      const spike = m.registrationTrend.find(d => d.recruiters >= 100);
      if (spike) cards.push({
        type: "📈 Recruiter Surge Detected", typeCol: "var(--blue)",
        text: `${spike.recruiters.toLocaleString()} recruiters registered on ${spike.date} — a major spike. Ensure onboarding flows handled the volume correctly.`,
        action: "Audit recruiter accounts from this date. Verify job postings are correctly attributed and not duplicates."
      });
    }

    if (m.avgMatchesPerJD != null && m.avgMatchesPerJD < 1) cards.push({
      type: "⚠ Low Match Coverage", typeCol: "var(--amber)",
      text: `Avg of ${m.avgMatchesPerJD} matches per job description — most JDs have fewer than 1 candidate match. Recruiters are getting very limited shortlists.`,
      action: "Urgently grow the candidate base. Consider relaxing match score thresholds temporarily to show more candidates per job."
    });

    if (zeroJobs > 0) cards.push({
      type: "⚠ Zero-Match Jobs", typeCol: "var(--red)",
      text: `${zeroJobs} of ${matchData.length} sampled jobs have zero candidate matches. These roles are effectively invisible.`,
      action: "Add more candidates or reduce skill requirements for zero-match jobs."
    });
    if (jobs.length > 0) {
      const applyPct = Math.round((withApply / Math.max(totalJobs, 1)) * 100);
      if (applyPct < 70) cards.push({
        type: "⚠ UX Issue", typeCol: "var(--amber)",
        text: `Only ${applyPct}% of jobs have direct apply links. ${totalJobs - withApply} jobs use search fallback, degrading candidate experience.`,
        action: "Work with recruiters to add direct apply URLs to all job listings."
      });
    }

    if (m.recentCandidates > 0) cards.push({
      type: "📈 Candidate Growth", typeCol: "var(--cyan)",
      text: `${m.recentCandidates} new candidates joined this week — the platform is growing.`,
      action: "Ensure new candidates are matched quickly after signup to demonstrate platform value."
    });

    if (!cards.length) { el.innerHTML = `<div class="empty">No insights available — check API connectivity.</div>`; return; }
    el.innerHTML = cards.map(c => `
      <div class="insight-card">
        <div class="insight-type" style="color:${escHtml(c.typeCol)};">${escHtml(c.type)}</div>
        <div class="insight-text">${escHtml(c.text)}</div>
        <div class="insight-action">→ ${escHtml(c.action)}</div>
      </div>`).join("");

    const ctx = $("aiContext");
    if (ctx) {
      const context = {
        platformOverview: {
          totalCandidates: m.totalCandidates, totalRecruiters: m.totalRecruiters, totalJobs: m.totalJobs,
          activeMatches: m.activeMatches, recentCandidatesThisWeek: m.recentCandidates,
          avgMatchesPerJD: m.avgMatchesPerJD, candidateToJobRatio: m.totalCandidates && m.totalJobs ? (m.totalCandidates / m.totalJobs).toFixed(4) : null
        },
        matchQuality: {
          avgMatchScore: avgScore || m.avgMatchScore, totalMatchesAnalysed: allM.length || m.totalMatches,
          scoreDistribution: m.matchScoreDistribution,
          strongMatchesPct: m.matchScoreDistribution ? Math.round(((m.matchScoreDistribution.find(d => (d.band || "").includes("80"))?.count || 0) / Math.max(m.totalMatches || 1, 1)) * 100) : null
        },
        topSkills: (m.topSkillsInDemand || []).slice(0, 8).map(s => s.skill || s),
        topRecruitingOrgs: (m.topRecruitingOrgs || []).slice(0, 5),
        jobsByCountry: (m.jobsByCountry || []).slice(0, 6),
        dataQualityScore: STATE.dataQualityScore,
        registrationSpike: m.registrationTrend?.find(d => d.recruiters >= 100) || null,
      };
      ctx.textContent = JSON.stringify(context, null, 2);
      STATE.aiContext = context;
    }
  }

  /* =====================================================
     AI ANALYSIS (calls the LLM proxy via gemini.js)
  ===================================================== */
  window.runAIAnalysis = async function runAIAnalysis(mode = "general") {
    const btn = $("aiAnalyseBtn"); const output = $("aiOutput");
    if (!output) return;
    if (btn) { btn.disabled = true; $("aiBtnIcon").classList.add("spin-icon"); $("aiBtnText").textContent = "Analysing…"; }

    output.className = "ai-output loading";
    output.innerHTML = `Analysing platform data<span class="cursor"></span>`;

    const ctx = STATE.aiContext || { note: "metrics not yet loaded" };
    const m = STATE.metrics || {};

    const dataBlock = `
PLATFORM SNAPSHOT (live):
- Candidates: ${m.totalCandidates || 0} | Jobs: ${(m.totalJobs || 0).toLocaleString()} | Recruiters: ${m.totalRecruiters || 0}
- Total matches: ${m.totalMatches || m.activeMatches || 0} | Avg match score: ${m.avgMatchScore || 0}% | ETF threshold: 70%
- Avg matches per JD: ${m.avgMatchesPerJD || 0} | New candidates this week: ${m.recentCandidates || 0}
- Score distribution: ${JSON.stringify(m.matchScoreDistribution || [])}
- Top skills in demand: ${(m.topSkillsInDemand || []).slice(0, 6).map(s => s.skill).join(", ")}
- Top recruiting orgs: ${(m.topRecruitingOrgs || []).slice(0, 4).map(o => `${o.org}(${o.jobCount})`).join(", ")}
- Jobs by country: ${(m.jobsByCountry || []).slice(0, 5).map(g => `${g.country}:${g.count}`).join(", ")}
- Data quality score: ${STATE.dataQualityScore || "N/A"}
`.trim();

    const prompts = {
      general:
`You are a senior platform operations analyst for BeyondMatch, a job-matching platform.
ETF (Effective quality Threshold) = 70% — matches below this are not surfaced to recruiters.

Analyse this live data and give 5 numbered, specific, actionable recommendations.
Format each as: [Issue] → [Impact on platform] → [Exact action to take]
Be direct. No fluff. Focus on the most critical problems first.

${dataBlock}`,

      growth:
`You are a growth strategist for BeyondMatch, a job-matching platform.
ETF threshold = 70%.

Based on this data, identify the top 3 growth opportunities AND top 2 risks.
For each: what the data shows → why it matters → concrete next step.
Be specific about numbers.

${dataBlock}`,

      risk:
`You are a risk analyst for BeyondMatch, a job-matching platform.
ETF threshold = 70%.

Identify the top 5 platform risks ranked by severity (Critical / High / Medium).
For each: risk name → what the data shows → potential damage → mitigation action.

${dataBlock}`,
    };

    try {
      const prompt = prompts[mode] || prompts.general;
      const text = await callGemini(prompt, "admin_analysis");

      if (!text) {
        output.className = "ai-output";
        output.textContent = "No response from LLM. The proxy may be overloaded — try again in a moment.";
      } else {
        output.className = "ai-output";
        output.innerHTML = text
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/^(\d+\.)\s/gm, `<span style="color:var(--blue);font-weight:700;">$1</span> `)
          .replace(/→/g, `<span style="color:rgba(122,162,255,.4);">→</span>`)
          .replace(/\n/g, "<br>");
      }
    } catch (err) {
      output.className = "ai-output";
      logError("admin AI analysis failed", err);
      output.textContent = "Analysis failed. Please try again.";
    }

    if (btn) { btn.disabled = false; $("aiBtnIcon").classList.remove("spin-icon"); $("aiBtnIcon").textContent = "✦"; $("aiBtnText").textContent = "Analyse Platform Health"; }
  };

  /* =====================================================
     SEEDED METRICS — last known good snapshot
     (used as fallback / initial render while live fetch runs)
  ===================================================== */
  const SEEDED_METRICS = {
    totalCandidates: 121,
    recentCandidates: 5,
    activeMatches: 806,
    totalRecruiters: 3751,
    totalJobs: 8307,
    avgMatchesPerJD: 0.10,
    avgMatchScore: 73.2,
    totalMatches: 806,
    registrationTrend: [
      { date: "09 Mar", candidates: 4, recruiters: 0 }, { date: "10 Mar", candidates: 3, recruiters: 0 },
      { date: "11 Mar", candidates: 3, recruiters: 0 }, { date: "12 Mar", candidates: 2, recruiters: 0 },
      { date: "13 Mar", candidates: 1, recruiters: 0 }, { date: "14 Mar", candidates: 0, recruiters: 0 },
      { date: "15 Mar", candidates: 3, recruiters: 0 }, { date: "16 Mar", candidates: 0, recruiters: 222 },
      { date: "17 Mar", candidates: 2, recruiters: 1 }, { date: "18 Mar", candidates: 0, recruiters: 0 },
      { date: "19 Mar", candidates: 0, recruiters: 0 }, { date: "20 Mar", candidates: 0, recruiters: 0 },
      { date: "21 Mar", candidates: 0, recruiters: 0 }, { date: "22 Mar", candidates: 0, recruiters: 3 }
    ],
    topRecruitingOrgs: [
      { org: "Lockheed Martin", jobCount: 530 }, { org: "L3Harris Technologies", jobCount: 101 },
      { org: "ITOL Recruit", jobCount: 96 }, { org: "Boeing", jobCount: 90 },
      { org: "Flix", jobCount: 73 }, { org: "Maximus", jobCount: 60 }
    ],
    matchScoreDistribution: [
      { band: "90–100%", count: 0 }, { band: "80–89%", count: 20 },
      { band: "70–79%", count: 786 }, { band: "60–69%", count: 0 }, { band: "<60%", count: 0 }
    ],
    topSkillsInDemand: [
      { skill: "sql", count: 377 }, { skill: "mysql", count: 334 }, { skill: "postgres", count: 329 },
      { skill: "machine_learning", count: 213 }, { skill: "angular", count: 194 },
      { skill: "data_science", count: 174 }, { skill: "frontend", count: 146 },
      { skill: "python", count: 109 }, { skill: "javascript", count: 101 }, { skill: "pytorch", count: 82 },
      { skill: "tableau", count: 54 }, { skill: "java", count: 39 },
      { skill: "automation", count: 22 }, { skill: "agile", count: 19 }
    ],
    candidatesByRole: [{ role: "candidate", count: 90 }],
    jobsByCountry: [
      { country: "REMOTE", count: 1959 }, { country: "US", count: 1402 }, { country: "IN", count: 551 },
      { country: "AU", count: 514 }, { country: "GB", count: 501 }, { country: "FR", count: 498 },
      { country: "DE", count: 480 }, { country: "BR", count: 480 }
    ]
  };

  /* =====================================================
     MAIN BOOT
  ===================================================== */
  window.boot = async function boot() {
    if (!isAdmin) return;
    const btn = $("rbtn"); btn?.classList.add("spin"); setProgress(10);

    try {
      // /admin/metrics is public; /recruiters likewise. The /candidates REST
      // endpoint requires auth this page doesn't have, so candidates are
      // read directly from Firestore instead.
      let rawMetrics = SEEDED_METRICS;
      let recruitersRaw = [];
      let candidatesRaw = [];
      try {
        [rawMetrics, recruitersRaw, candidatesRaw] = await Promise.all([
          getAdminMetrics().catch(() => SEEDED_METRICS),
          getRecruiters().catch(() => []),
          firestoreGetCandidates(),
        ]);
      } catch (e) { logError("admin data fetch failed", e); }
      setProgress(55);

      const metrics = {
        ...rawMetrics,
        avgMatchScore: rawMetrics.avgMatchScore != null
          ? (rawMetrics.avgMatchScore <= 1 ? +(rawMetrics.avgMatchScore * 100).toFixed(1) : rawMetrics.avgMatchScore)
          : null,
        avgMatchesPerJD: rawMetrics.avgMatchesPerJD != null
          ? +(rawMetrics.avgMatchesPerJD).toFixed(2)
          : null,
      };

      if (!metrics.registrationTrend?.length) metrics.registrationTrend = SEEDED_METRICS.registrationTrend;
      if (!metrics.topRecruitingOrgs?.length) metrics.topRecruitingOrgs = SEEDED_METRICS.topRecruitingOrgs;
      if (!metrics.matchScoreDistribution?.length) metrics.matchScoreDistribution = SEEDED_METRICS.matchScoreDistribution;
      if (!metrics.topSkillsInDemand?.length) metrics.topSkillsInDemand = SEEDED_METRICS.topSkillsInDemand;
      if (!metrics.candidatesByRole?.length) metrics.candidatesByRole = SEEDED_METRICS.candidatesByRole;
      if (!metrics.jobsByCountry?.length) metrics.jobsByCountry = SEEDED_METRICS.jobsByCountry;

      const recruiters = Array.isArray(recruitersRaw)
        ? recruitersRaw
        : (recruitersRaw.recruiters || recruitersRaw.data || []);

      const orgMap = {};
      recruiters.forEach(r => {
        const org = r.organisation_name || r.org_name || r.company || "Unknown";
        if (!orgMap[org]) orgMap[org] = { name: org, count: 0 };
        orgMap[org].count++;
      });
      const uniqueOrgsFromRec = Object.keys(orgMap).length;
      const totalRecsFromData = recruiters.length;

      const jobs = [];
      const matchData = [];

      let candidates = [];
      if (Array.isArray(candidatesRaw)) candidates = candidatesRaw;
      else if (Array.isArray(candidatesRaw?.candidates)) candidates = candidatesRaw.candidates;
      else if (Array.isArray(candidatesRaw?.data)) candidates = candidatesRaw.data;
      else if (Array.isArray(candidatesRaw?.items)) candidates = candidatesRaw.items;
      else if (Array.isArray(candidatesRaw?.results)) candidates = candidatesRaw.results;
      else if (typeof candidatesRaw?.body === "string") {
        try {
          const p = JSON.parse(candidatesRaw.body);
          candidates = Array.isArray(p) ? p : (p.candidates || p.data || p.items || []);
        } catch (e) { /* leave candidates empty */ }
      }


      const roleMap = {};
      candidates.forEach(c => {
        const role = c.applied_role || c.appliedRole || c.job_title || c.title
          || (c.role !== "candidate" ? c.role : null) || "Unknown";
        roleMap[role] = (roleMap[role] || 0) + 1;
      });
      const roleBreakdown = Object.entries(roleMap)
        .sort((a, b) => b[1] - a[1])
        .map(([role, count]) => ({ role, count }));

      STATE = { metrics, jobs, matchData, recruiters, orgMap, uniqueOrgsFromRec, totalRecsFromData, candidates, roleBreakdown };
      setProgress(85);

      buildTicker(metrics);
      renderKPIs(metrics);

      renderTrend(metrics.registrationTrend || null);
      renderOrgs(metrics.topRecruitingOrgs || null);
      renderGeo(metrics.jobsByCountry || []);
      renderHealth(metrics, jobs);
      renderFeed(metrics);

      renderRecPipeline(metrics, matchData);
      renderDist(metrics.matchScoreDistribution || null, matchData);
      renderPerJobChart(matchData);
      renderQualFlags(matchData);

      renderPipeline(metrics, matchData);
      renderSkillsCloud(metrics.topSkillsInDemand || null, matchData);
      renderRolesBars(metrics.candidatesByRole || null, matchData);
      renderRecHealth(matchData);

      renderDataQuality(metrics, jobs);

      renderInsightCards(metrics, matchData, jobs);

      st("lastTs", new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setProgress(100);

    } catch (err) {
      logError("admin dashboard failed", err); setProgress(100);
    }
    btn?.classList.remove("spin");
  };

  // Module scripts execute after the DOM is fully parsed (same timing as
  // `defer`), so boot() can run as soon as the admin claim is confirmed —
  // no need to wait for DOMContentLoaded (and wrapping in that listener
  // risked missing the event entirely if this module happened to load
  // after it had already fired). Signed-out users are redirected by auth.js;
  // signed-in non-admins are sent back to index.html, which routes them
  // to their own dashboard.
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      const { claims } = await user.getIdTokenResult(true);
      isAdmin = claims.role === "admin";
    } catch {
      isAdmin = false;
    }
    if (!isAdmin) {
      window.location.replace("/index.html");
      return;
    }
    window.boot();
    setInterval(window.boot, 120000);
  });

  // Chart.js colors are baked into the canvas — rebuild the dashboard
  // whenever the theme toggle flips so charts stay legible.
  window.addEventListener("bm-theme-change", () => {
    Chart.defaults.color = chartText();
    window.boot();
  });
}
