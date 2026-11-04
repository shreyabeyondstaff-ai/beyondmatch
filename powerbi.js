/* =========================================================
   POWERBI.JS
   Consolidates the near-identical embedReport() implementations
   previously duplicated in candidate-dashboard.html and
   rec-dash.html. The one real difference between them — the
   candidate dashboard supports an AAD token type (tokenType "0")
   while the recruiter dashboard always uses an Embed token — is
   preserved via the `tokenType` parameter rather than picked
   for one page and silently dropped for the other.

   Fetching the embed token itself (the Lambda call + response
   parsing) already lives in api.js's getEmbedToken() — this
   file only does the actual powerbi-client embed() call.
========================================================= */

import { showErrorBanner, logError } from "./utils.js";

/**
 * Shows an error message in the dashboard's error banner. Thin,
 * Power-BI-scoped alias for utils.js's showErrorBanner, so pages
 * that only deal with Power BI don't need a separate utils.js
 * import just for this one call.
 */
export function showPowerBIError(msg, bannerId = "errBanner") {
  showErrorBanner(msg, bannerId);
}

/**
 * @param {Object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.embedUrl
 * @param {string} [opts.reportId]  — from the backend response; if absent, powerbi-client reads it from embedUrl
 * @param {string} [opts.tokenType="1"]    — "0"/0 = AAD, anything else = Embed
 * @param {string} [opts.containerId="pbi-container"]
 * @param {string} [opts.shimmerId="pbi-shimmer"]     — loading placeholder, removed on embed
 * @param {string} [opts.errorBannerId="errBanner"]
 * @param {() => void} [opts.onLoaded]
 * @param {() => void} [opts.onRendered]
 * @returns the powerbi-client report instance, or null if the embed URL was rejected
 */
export function embedPowerBI({
  accessToken,
  embedUrl,
  reportId,
  tokenType = "1",
  containerId = "pbi-container",
  shimmerId = "pbi-shimmer",
  errorBannerId = "errBanner",
  onLoaded,
  onRendered
}) {
  // SEC-05: only ever embed from a Microsoft Power BI host over https, even
  // if the backend response were tampered with.
  let host = "";
  try {
    const u = new URL(embedUrl);
    if (u.protocol === "https:") host = u.hostname;
  } catch { /* invalid URL */ }
  if (host !== "app.powerbi.com" && !host.endsWith(".powerbi.com")) {
    showErrorBanner("Power BI error: unexpected embed URL.", errorBannerId);
    return null;
  }

  const models    = window["powerbi-client"].models;
  const container = document.getElementById(containerId);
  document.getElementById(shimmerId)?.remove();

  const resolvedTokenType = (tokenType === "0" || tokenType === 0)
    ? models.TokenType.Aad
    : models.TokenType.Embed;

  const report = window.powerbi.embed(container, {
    type:        "report",
    id:          reportId || undefined,
    embedUrl,
    accessToken,
    tokenType:   resolvedTokenType,
    permissions: models.Permissions.Read, // view-only (SEC-05)
    settings: {
      navContentPaneEnabled: false,
      background:            models.BackgroundType.Transparent,
      panes: {
        filters:        { visible: false },
        pageNavigation: { visible: true }
      }
    }
  });

  report.on("error", e => {
    // e.detail can carry service messages; log only its code.
    logError("power bi embed failed", { code: e.detail?.errorCode });
    showErrorBanner("The dashboard could not be displayed. Please try again later.", errorBannerId);
  });

  report.on("loaded", () => {
    onLoaded?.();
  });

  report.on("rendered", () => {
    onRendered?.();
  });

  return report;
}
