#!/usr/bin/env node
// Disable SSL certificate validation globally
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Load environment variables from .env file
require('dotenv').config();

// modbus-set-mode-api.js (schema-safe, no-throw version)

const DEFAULT_URL = process.env.GRAPHQL_URL;
const DEFAULT_TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);

// Public: exported so callers can validate/iterate modes if they want.
const MODE_MAP = {
  "ttid":            { enableLegacyMode: false, enableModbusSorting: false },
  "legacy-unsorted": { enableLegacyMode: true,  enableModbusSorting: false },
  "legacy-sorted":   { enableLegacyMode: true,  enableModbusSorting: true  },
};

// We’ll dynamically build the mutation with different selection sets.
const SELECTIONS = [
  'modbusService { enableModbusService enableModbusWrites enableModbusSorting enableLegacyMode }', // optimistic
  'modbusService { enableModbusService enableModbusWrites }',                                       // conservative
  'modbusService { __typename }',                                                                    // very safe
  '__typename'                                                                                       // ultra-safe
];

function buildMutation(selection) {
  return `
    mutation updateModbusServiceConfig($modbusServiceConfigData: ModbusServiceConfigInput) {
      updateModbusServiceConfig(configData: $modbusServiceConfigData) {
        ${selection}
      }
    }
  `;
}

function makeHeaders({ url, xsrfToken, xsrfCookie, accessToken, cookie }) {
  const h = { "content-type": "application/json" };
  if (xsrfToken)  h["x-xsrftoken"] = xsrfToken;

  let cookieHeader = cookie || "";
  const parts = [];
  if (xsrfCookie) parts.push(`_xsrf=${xsrfCookie}`);
  if (accessToken) parts.push(`access_token=${accessToken}`);
  if (cookieHeader) parts.push(cookieHeader);
  cookieHeader = parts.join("; ");
  if (cookieHeader) h.cookie = cookieHeader;

  try {
    const { protocol, host } = new URL(url);
    h.Referer = `${protocol}//${host}/config-modbus`;
  } catch {}
  return h;
}

async function ensureFetch() {
  if (typeof fetch === "function") return fetch;
  const { default: fetchImpl } = await import("node-fetch");

  const https = require('https');
  const agent = new https.Agent({ rejectUnauthorized: false, checkServerIdentity: () => undefined });

  return (url, options = {}) => fetchImpl(url, { ...options, agent });
}

async function postUpdate({ url, headers, variables, timeoutMs, fetchImpl, verbose, selection }) {
  const query = buildMutation(selection);
  const body = {
    operationName: "updateModbusServiceConfig",
    query,
    variables
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  if (verbose) {
    const safeHeaders = { ...headers };
    if (safeHeaders.cookie) safeHeaders.cookie = "[REDACTED]";
    if (safeHeaders["x-xsrftoken"]) safeHeaders["x-xsrftoken"] = "[REDACTED]";
    console.log("→ POST", url);
    console.log("→ Selection:", selection);
    console.log("→ Variables:", variables);
  }

  let res, text, json;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(t);
  }

  try { json = JSON.parse(text); }
  catch { return { ok: false, status: res?.status, json: null, text, error: new Error(`Non-JSON response (status ${res?.status}): ${text}`) }; }

  if (!res.ok) return { ok: false, status: res.status, json, text, error: new Error(`HTTP ${res.status}: ${text}`) };
  if (json.errors && json.errors.length) return { ok: false, status: res.status, json, text, error: new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`) };

  return { ok: true, status: res.status, json, text, error: null };
}

function scrubUnsupportedFlagsFromError(flags, errMsg) {
  let changed = false;
  if (/enableModbusSorting/i.test(errMsg) && flags.hasOwnProperty('enableModbusSorting')) {
    delete flags.enableModbusSorting; changed = true;
  }
  if (/enableLegacyMode/i.test(errMsg) && flags.hasOwnProperty('enableLegacyMode')) {
    delete flags.enableLegacyMode; changed = true;
  }
  return changed;
}

async function setFlags({ url, headers, timeoutMs, flags, fetchImpl, verbose }) {
  // Try multiple selection sets and adapt both selection & inputs on the fly.
  let flagsToSend = { ...flags };

  for (let attempt = 0; attempt < 6; attempt++) {
    // Cycle through selection sets
    for (const selection of SELECTIONS) {
      const res = await postUpdate({
        url,
        headers,
        variables: { modbusServiceConfigData: flagsToSend },
        timeoutMs,
        fetchImpl,
        verbose,
        selection
      });

      if (res.ok) {
        if (verbose) console.log("✓ Update applied.");
        // Prefer returning the deepest object if present
        const node = res.json?.data?.updateModbusServiceConfig?.modbusService ?? res.json?.data?.updateModbusServiceConfig ?? res.json?.data;
        return { ok: true, selection, appliedFlags: { ...flagsToSend }, response: node };
      }

      const msg = String(res.error?.message || "");
      // If the error is only about the selection set, try the next (more conservative) selection.
      if (/Cannot query field .* on type "ModbusService"/i.test(msg)) {
        if (verbose) console.warn(`⚠️ Selection too ambitious (${selection}). Retrying with a smaller selection…`);
        continue;
      }

      // If inputs not supported, drop them and retry
      if (/Unknown (argument|field)/i.test(msg) || /Field .* is not defined/i.test(msg)) {
        const removed = scrubUnsupportedFlagsFromError(flagsToSend, msg);
        if (removed) {
          if (verbose) console.warn(`⚠️ Server doesn’t accept some flags. Retrying with reduced inputs:`, flagsToSend);
          // Restart selection attempts from the top with reduced flags
          break;
        }
      }

      // Other errors: log and keep trying with next selection
      if (verbose) console.warn(`⚠️ Update failed with selection "${selection}": ${msg}`);
    }

    // If all flags were removed, nothing left to set—treat as non-fatal
    if (Object.keys(flagsToSend).length === 0) {
      if (verbose) console.warn("ℹ️ No compatible flags remain; assuming mode toggles unsupported on this server.");
      return { ok: false, skipped: true, reason: "Unsupported flags", appliedFlags: {} };
    }
  }

  return { ok: false, skipped: true, reason: "Exhausted retries", appliedFlags: { ...flagsToSend } };
}

/**
 * Library API: setModbusMode
 * @param {"ttid"|"legacy-unsorted"|"legacy-sorted"} mode
 * @param {{
 *   url?: string,
 *   accessToken?: string,
 *   xsrfToken?: string,
 *   xsrfCookie?: string,
 *   cookie?: string,
 *   timeoutMs?: number,
 *   verbose?: boolean
 * }} options
 * @returns {Promise<object>} never throws; returns {ok:boolean, skipped?:boolean, ...}
 */
async function setModbusMode(mode, options = {}) {
  const flags = MODE_MAP[String(mode).toLowerCase()];
  if (!flags) {
    return { ok: false, skipped: true, reason: `Invalid mode "${mode}"` };
  }

  const url = options.url || DEFAULT_URL;
  const headers = makeHeaders({
    url,
    accessToken: options.accessToken || process.env.ACCESS_TOKEN || "",
    xsrfToken:   options.xsrfToken   || process.env.XSRF_TOKEN   || "",
    xsrfCookie:  options.xsrfCookie  || process.env._XSRF_COOKIE || "",
    cookie:      options.cookie      || process.env.COOKIE       || "",
  });

  const fetchImpl = await ensureFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const verbose   = !!options.verbose;

  if (verbose) {
    console.log(`\n🔧 Setting mode: ${mode}  (legacy=${flags.enableLegacyMode}, sorting=${flags.enableModbusSorting})`);
  }

  const result = await setFlags({ url, headers, timeoutMs, flags, fetchImpl, verbose });

  // Do not throw—callers (like your generator) can proceed regardless.
  return result;
}

// --- Exports (library) ---
module.exports = { setModbusMode, MODE_MAP };

// --- CLI glue (optional) ---
if (require.main === module) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      const getFlag = (name, fallback) => {
        const i = args.findIndex(a => a === `--${name}`);
        return (i !== -1 && i + 1 < args.length) ? args[i + 1] : fallback;
      };

      const mode = (getFlag("mode", "") || "").toLowerCase();
      const url  = getFlag("url", DEFAULT_URL);
      const accessToken = process.env.ACCESS_TOKEN  || getFlag("access_token") || "";
      const xsrfToken   = process.env.XSRF_TOKEN    || getFlag("xsrf") || "";
      const xsrfCookie  = process.env._XSRF_COOKIE  || getFlag("_xsrf") || "";
      const cookie      = getFlag("cookie", process.env.COOKIE || "");
      const verbose     = args.includes("--verbose");
      const timeoutMs   = Number(process.env.TIMEOUT_MS || getFlag("timeout", DEFAULT_TIMEOUT_MS));

      if (!MODE_MAP[mode]) {
        console.error('Usage: node modbus-set-mode-api.js --mode ttid|legacy-unsorted|legacy-sorted [--url https://host/graphql] [--verbose]');
        process.exit(1);
      }

      const out = await setModbusMode(mode, { url, accessToken, xsrfToken, xsrfCookie, cookie, timeoutMs, verbose });
      if (verbose) console.log("Result:", out);
      if (!out.ok && !out.skipped) process.exit(2);
    } catch (err) {
      console.error("❌", err.message || err);
      process.exit(1);
    }
  })();
}
