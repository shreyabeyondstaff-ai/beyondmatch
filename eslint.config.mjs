// ESLint flat config. Lint only: it never changes how the app is built or served.
//
//   npm run lint
//
// Errors are reserved for real bugs (undefined names, duplicate keys, unreachable
// code, eval) and fail CI. Style issues are warnings. The security rule
// `no-unsanitized` reports `innerHTML` and similar assignments; the app escapes
// with escHtml/escAttr (utils.js), which the rule is told about, so what it still
// reports are templates it cannot prove safe: review them, they are warnings so
// they show up without blocking.
import noUnsanitized from "eslint-plugin-no-unsanitized";

const browser = Object.fromEntries([
  "window", "document", "navigator", "location", "history", "console", "fetch", "localStorage",
  "sessionStorage", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "alert", "confirm", "prompt", "URL", "URLSearchParams", "Blob", "FormData", "File", "FileReader",
  "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "Response", "Request", "Headers",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "Event", "CustomEvent", "Image", "Worker",
  "CSS", "crypto", "performance", "structuredClone", "atob", "btoa", "getComputedStyle", "matchMedia",
  "Promise", "Map", "Set", "WeakMap", "Intl", "JSON", "Math", "Date", "Number", "String", "Object", "Array",
  "Error", "TypeError", "Symbol", "RegExp", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "globalThis", "queueMicrotask"
].map(n => [n, "readonly"]));

// Libraries loaded by <script> tags (see package.json and the HTML pages).
const vendor = Object.fromEntries(["L", "Chart", "XLSX", "mammoth", "pdfjsLib", "powerbi"].map(n => [n, "readonly"]));

const node = Object.fromEntries(["process", "console", "Buffer", "URL", "setTimeout"].map(n => [n, "readonly"]));

export default [
  { ignores: ["node_modules/**", "libs/**", "security-tests/**", "Testing/**", "package-lock.json"] },
  // Node scripts (not shipped to the browser)
  {
    files: ["tools/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: node },
    rules: { "no-undef": "error" }
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...browser, ...vendor }
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: {
      // ---- bugs: errors
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      "no-func-assign": "error",
      "no-class-assign": "error",
      "no-import-assign": "error",
      "no-redeclare": "error",
      "no-self-assign": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-finally": "error",
      "no-sparse-arrays": "error",
      "no-empty-pattern": "error",
      "no-invalid-regexp": "error",
      "no-loss-of-precision": "error",
      "no-obj-calls": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "getter-return": "error",
      "constructor-super": "error",
      "no-this-before-super": "error",
      "no-global-assign": "error",
      // ---- dangerous APIs: errors (the CSP already forbids them at runtime)
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      // ---- quality: warnings
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "eqeqeq": ["warn", "smart"],
      "no-var": "warn",
      "prefer-const": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-cond-assign": ["warn", "except-parens"],
      "no-prototype-builtins": "warn",
      // ---- security: warnings (see header)
      "no-unsanitized/method": ["warn", { escape: { methods: ["escHtml", "escAttr"] } }],
      "no-unsanitized/property": ["warn", { escape: { methods: ["escHtml", "escAttr"] } }]
    }
  }
];
