/* =========================================================
   CONFIG.JS
   Single source of truth for: Firebase app/auth/db/analytics
   instances, backend URLs, and app-wide constants. Every other
   module imports what it needs from here — nothing in this
   file talks to the DOM or contains business logic.
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAnalytics }   from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";

/* ── Firebase ──
   These values identify the Firebase project to the SDK and ARE visible to
   every visitor; they are public by design and are not secrets. What actually
   protects the project is (a) the Firestore security rules, (b) restricting
   this web API key to the site's domains and the APIs the app uses in the
   Google Cloud console (Credentials), and (c) App Check. See
   SECURITY_REMEDIATION.md, SEC-15. */
const firebaseConfig = {
  apiKey:            "AIzaSyCbrwCaaQYEFCF1FJto_O3OYi68qTOqGQc",
  authDomain:        "beyondmatch-a714f.firebaseapp.com",
  projectId:         "beyondmatch-a714f",
  storageBucket:     "beyondmatch-a714f.firebasestorage.app",
  messagingSenderId: "16758090560",
  appId:             "1:16758090560:web:89f207139970c97592a8a5",
  measurementId:     "G-VZN3JKW8DX"
};

export const firebaseApp = initializeApp(firebaseConfig);

/* ── App Check ──
   The reCAPTCHA Enterprise site key is public (like the Firebase config).
   App Check must start before Auth and Firestore so their requests carry the
   token. Paste the real key below; until you do, App Check stays off. Do not
   turn on "Enforce" in the Firebase console until tokens show as verified. */
const APP_CHECK_SITE_KEY = "6Lc_8RAuAAAAABzsHrtinUqwYSKjk5kpbz70IOS9";
if (!APP_CHECK_SITE_KEY.startsWith("PASTE_")) {
  try {
    initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } catch { /* the app keeps working; App Check just stays off */ }
}

export const auth        = getAuth(firebaseApp);
export const db           = getFirestore(firebaseApp);
export const analytics    = getAnalytics(firebaseApp);

/* ── Backend ──
   The API Gateway base URL is public configuration (the browser must call it)
   and is the single place it is defined for the app. It is also named in the
   Content-Security-Policy `connect-src` in customHttp.yml: change both
   together. Authorization never depends on this value or on any identifier in
   this file; it comes from the verified Firebase token. */
export const API_BASE     = "https://wx0334lyy6.execute-api.eu-north-1.amazonaws.com";
export const LLM_ENDPOINT = `${API_BASE}/llm`;
export const EMBED_URL_ENDPOINT = `${API_BASE}/getEmbedUrl`;

/* ── Access control ──
   Roles (candidate / recruiter / admin) and "Find Leads" access come
   from server-issued Firebase custom claims (role, findLeads), set
   only via the Admin SDK — never from a client-side constant. */

/* ── Where each role lands after login/signup ── */
export const ROLE_DASHBOARD_ROUTES = {
  recruiter: "/rec-dash.html",
  admin:     "/admin.html",
  candidate: "/candidate-dashboard.html"
};
