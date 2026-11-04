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
})();
