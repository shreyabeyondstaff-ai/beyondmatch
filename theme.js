/* ============================================================
   BeyondMatch — shared theme engine
   Include this as the FIRST thing in <head> (before any
   <link rel="stylesheet">) so the correct theme is applied
   before first paint (no flash of the wrong theme).

   Usage:
     <script src="theme.js"></script>          <!-- in <head>, first -->
     ...
     <button data-theme-toggle>...</button>     <!-- anywhere, any page -->

   Public API:  window.BMTheme.get() / .set(theme) / .toggle() / .color(name)
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "bm-theme";
  var VALID = ["dark", "light"];

  function systemPref() {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function getTheme() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (VALID.indexOf(saved) !== -1) return saved;
    } catch (e) {}
    return "dark"; // BeyondMatch defaults to dark regardless of OS pref
  }

  function paint(theme) {
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    // Keep a class too, in case any selector prefers it
    root.classList.toggle("theme-light", theme === "light");
    root.classList.toggle("theme-dark", theme === "dark");
    // Helps native form controls / scrollbars pick a sane default
    root.style.colorScheme = theme;
  }

  function syncToggles(theme) {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      var btn = toggles[i];
      btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      btn.setAttribute(
        "title",
        theme === "light" ? "Switch to dark mode" : "Switch to light mode"
      );
      var label = btn.querySelector("[data-theme-label]");
      if (label) label.textContent = theme === "light" ? "Light mode" : "Dark mode";
    }
  }

  function applyTheme(theme) {
    if (VALID.indexOf(theme) === -1) theme = "dark";
    paint(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {}
    syncToggles(theme);
    try {
      window.dispatchEvent(new CustomEvent("bm-theme-change", { detail: { theme: theme } }));
    } catch (e) {}
  }

  function toggleTheme() {
    var next = getTheme() === "light" ? "dark" : "light";
    applyTheme(next);
    return next;
  }

  // Read a semantic color for the CURRENT theme straight off the CSS
  // custom properties, so dynamically-injected JS UI (toasts, badges,
  // canvas/chart colors) can stay in sync with the active theme.
  // e.g. BMTheme.color('blue') -> '#7aa2ff' (dark) or '#3a5fd9' (light)
  function color(name, fallback) {
    try {
      var cs = getComputedStyle(document.documentElement);
      var v = cs.getPropertyValue("--" + name.replace(/^--/, "")).trim();
      return v || fallback || "";
    } catch (e) {
      return fallback || "";
    }
  }

  // Apply immediately — this script must be loaded synchronously in <head>
  // before other stylesheets/scripts to prevent a flash of the wrong theme.
  paint(getTheme());

  // Sidebar state is applied here too, before first paint, so the page never
  // flashes the wide sidebar and then collapses. Collapsed is the default.
  var SIDEBAR_KEY = "bm-sidebar";
  try {
    document.documentElement.classList.toggle("sb-collapsed", localStorage.getItem(SIDEBAR_KEY) !== "open");
  } catch (e) {
    document.documentElement.classList.add("sb-collapsed");
  }

  window.BMTheme = {
    get: getTheme,
    set: applyTheme,
    toggle: toggleTheme,
    color: color
  };

  function wireButtons() {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      if (toggles[i].__bmWired) continue;
      toggles[i].__bmWired = true;
      toggles[i].addEventListener("click", function () {
        toggleTheme();
      });
    }
    syncToggles(getTheme());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireButtons);
  } else {
    wireButtons();
  }

  // In case a toggle button gets injected later (e.g. settings.html builds
  // its sidebar dynamically), re-scan shortly after and on demand.
  window.BMTheme.rescan = wireButtons;

  /* ============================================================
     Collapsible sidebar (every view)
     A menu button opens and closes the sidebar. Closed, it is a
     narrow rail of icons and the page name shows on hover. The
     choice is remembered. All sidebar markup variants share this
     one script: .sidebar / .cand-sidebar, with .menu-item,
     .cand-menu-item or .nav-link entries.
     ============================================================ */
  var SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICONS = {
    menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    plus: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    check: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    dot: '<circle cx="12" cy="12" r="4"/>'
  };
  // page file name -> icon
  var PAGE_ICONS = {
    "rec-dash": "grid", "candidate-dashboard": "grid", "rec-postjob": "plus", "rec-jobs": "briefcase",
    "jobs": "list", "cand-matches": "users", "jobmatches": "star", "rec-locatehire": "pin",
    "locatehire": "pin", "rec-leads": "target", "rec-actions": "check", "cand_actions": "check",
    "settings": "sliders", "resume": "file", "savedjobs": "bookmark", "admin": "shield"
  };

  function iconSvg(name) {
    return SVG_OPEN + (ICONS[name] || ICONS.dot) + "</svg>";
  }

  function iconNameFor(el) {
    if (el.classList.contains("logout-btn")) return "logout";
    var href = (el.getAttribute("href") || "").split("?")[0].split("#")[0].split("/").pop();
    return PAGE_ICONS[href.replace(/\.html$/, "").toLowerCase()] || "dot";
  }

  function enhanceItem(el) {
    if (el.__bmSb) return;
    el.__bmSb = true;
    el.classList.add("sb-tip");
    if (el.classList.contains("theme-toggle-btn")) {
      el.setAttribute("data-label", "Light / dark mode");
      return;
    }
    var textNodes = [];
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) textNodes.push(n);
    }
    var label = textNodes.map(function (t) { return t.nodeValue; }).join(" ")
      .replace(/⏻/g, "").replace(/\s+/g, " ").trim();
    if (!label) return;
    var labelEl = document.createElement("span");
    labelEl.className = "sb-label";
    labelEl.textContent = label;
    el.replaceChild(labelEl, textNodes[0]);
    for (var i = 1; i < textNodes.length; i++) el.removeChild(textNodes[i]);
    var iconEl = document.createElement("span");
    iconEl.className = "sb-icon";
    iconEl.innerHTML = iconSvg(iconNameFor(el)); // constant markup, no user data
    el.insertBefore(iconEl, el.firstChild);
    el.classList.add("sb-item");
    el.setAttribute("data-label", label);
    el.setAttribute("aria-label", label);
  }

  function initSidebar() {
    var aside = document.querySelector("aside.sidebar, aside.cand-sidebar");
    if (!aside) return;
    var root = document.documentElement;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sb-toggle sb-tip";
    btn.innerHTML = iconSvg("menu"); // constant markup, no user data

    function sync() {
      var collapsed = root.classList.contains("sb-collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("aria-label", collapsed ? "Open menu" : "Close menu");
      btn.setAttribute("data-label", collapsed ? "Open menu" : "Close menu");
    }
    btn.addEventListener("click", function () {
      var collapsed = !root.classList.contains("sb-collapsed");
      root.classList.toggle("sb-collapsed", collapsed);
      try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "closed" : "open"); } catch (e) {}
      sync();
      // maps and charts size themselves from the window, so tell them the width changed
      setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 260);
    });
    aside.insertBefore(btn, aside.firstChild);
    sync();

    function scan() {
      var items = aside.querySelectorAll("a.menu-item, a.cand-menu-item, a.nav-link, .logout-btn, .theme-toggle-btn");
      for (var i = 0; i < items.length; i++) enhanceItem(items[i]);
      // a fixed sidebar (cand.css) needs the page content moved by hand
      root.classList.toggle("sb-fixed", getComputedStyle(aside).position === "fixed");
    }
    scan();
    window.addEventListener("load", scan);
    // settings.html builds its menu with JS after load
    try { new MutationObserver(scan).observe(aside, { childList: true, subtree: true }); } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebar);
  } else {
    initSidebar();
  }
})();
