// generateAllReports.js
// Comprehensive Modbus report runner with loud logs + .env override + clean output dir.

const path = require("path");
const fs = require("fs");

// 1) Load .env from the current working directory (override shell envs)
require("dotenv").config({
  path: path.resolve(process.cwd(), ".env"),
  override: true,
});

// 2) Import your existing modules
const csvModbusTTID = require("./csvModbusTTID");
const csvModbusPosition = require("./csvModbusPosition");
const csvSortedBatchRead = require("./csvSortedBatchRead");
const { setModbusMode } = require("./modbus-set-mode-api");

// 3) Safety: catch any unhandled errors so we always see output
process.on("unhandledRejection", (err) => {
  console.error("❌ UnhandledRejection:", err?.stack || err);
  process.exitCode = 1;
});
process.on("uncaughtException", (err) => {
  console.error("❌ UncaughtException:", err?.stack || err);
  process.exit(1);
});

// Small helper to read envs with fallback
const env = (k, fallback) => (process.env[k] ?? fallback);
const mask = (v) => (v ? v.slice(0, 3) + "…" + v.slice(-4) : "");

// Output directory helpers
const OUT_DIR = path.resolve(__dirname, "modbus_csv_outputs");
function resetOutputDir() {
  try {
    if (fs.existsSync(OUT_DIR)) {
      fs.rmSync(OUT_DIR, { recursive: true, force: true });
      console.log(`🧹 Deleted existing output dir: ${OUT_DIR}`);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`📂 Created fresh output dir:   ${OUT_DIR}`);
  } catch (e) {
    console.error("❌ Failed to reset output dir:", e?.message || e);
    throw e;
  }
}

// 4) Core function
async function generateAllReports(
  site = env("SITE", "192.168.12.73"),
  ttidCsvPath = env("TTID_CSV_PATH", "./sample_ttids.csv"),
  positionCsvPath = env("POSITION_CSV_PATH", "./sample_positions.csv")
) {
  const ENV_VERBOSE = String(process.env.VERBOSE).toLowerCase() === "true";
  const gqlUrl = env("GRAPHQL_URL", `https://${site}/graphql`);
  const accessToken = env("ACCESS_TOKEN", "");
  const xsrfToken = env("XSRF_TOKEN", "");
  const xsrfCookie = env("_XSRF_COOKIE", "");

  // Loud startup diagnostics
  console.log("==============================================");
  console.log("🚀 Starting comprehensive Modbus report run");
  console.log("• CWD:          ", process.cwd());
  console.log("• .env path:    ", path.resolve(process.cwd(), ".env"));
  console.log("• Site:         ", site);
  console.log("• GRAPHQL_URL:  ", gqlUrl);
  console.log("• VERBOSE:      ", ENV_VERBOSE);
  console.log("• TTID CSV:     ", fs.existsSync(ttidCsvPath) ? ttidCsvPath : `(missing) ${ttidCsvPath}`);
  console.log("• Position CSV: ", fs.existsSync(positionCsvPath) ? positionCsvPath : `(missing) ${positionCsvPath}`);
  console.log("• ACCESS_TOKEN: ", mask(accessToken));
  console.log("• XSRF_TOKEN:   ", mask(xsrfToken));
  console.log("• _XSRF_COOKIE: ", mask(xsrfCookie));
  console.log("==============================================");

  // 🔥 Clean output directory BEFORE generating anything
  resetOutputDir();

  const allResults = [];
  const errors = [];

  // 1) TTID Sorted (modern/TTID mapping)
  if (ttidCsvPath && fs.existsSync(ttidCsvPath)) {
    try {
      await setModbusMode("ttid", {
        url: gqlUrl,
        accessToken,
        xsrfToken,
        xsrfCookie,
        verbose: ENV_VERBOSE,
      });

      console.log("\n📊 Generating TTID Sorted Reports…");
      const ttidResult = await csvModbusTTID({ site, TYPE: "row" }, ttidCsvPath);

      if (ttidResult?.error) {
        console.error("❌ TTID processing error:", ttidResult.error);
        errors.push({ type: "TTID Sorted", error: ttidResult.error });
      } else {
        console.log("✅ TTID Sorted reports generated!");
        console.log(`   • Reports: ${ttidResult.reports.length}`);
        console.log(`   • Index:   ${ttidResult.indexPath}`);
        allResults.push({
          category: "TTID Sorted",
          reports: ttidResult.reports,
          indexPath: ttidResult.indexPath,
          success: true,
        });
      }
    } catch (err) {
      console.error("❌ TTID processing failed:", err.message);
      if (ENV_VERBOSE) console.error(err);
      errors.push({ type: "TTID Sorted", error: err.message });
    }
  } else {
    console.warn("⚠️  Skipping TTID Sorted: TTID CSV not found.");
  }

  // 2) Legacy Unsorted (position-based assets)
  if (positionCsvPath && fs.existsSync(positionCsvPath)) {
    try {
      await setModbusMode("legacy-unsorted", {
        url: gqlUrl,
        accessToken,
        xsrfToken,
        xsrfCookie,
        verbose: ENV_VERBOSE,
      });

      console.log("\n📊 Generating Legacy Unsorted Reports…");
      const positionResult = await csvModbusPosition({ site, type: "assets" }, positionCsvPath);

      if (positionResult?.error) {
        console.error("❌ Legacy Unsorted processing error:", positionResult.error);
        errors.push({ type: "Legacy Unsorted", error: positionResult.error });
      } else {
        console.log("✅ Legacy Unsorted reports generated!");
        console.log(`   • Reports: ${positionResult.reports.length}`);
        console.log(`   • Index:   ${positionResult.indexPath}`);
        allResults.push({
          category: "Legacy Unsorted",
          reports: positionResult.reports,
          indexPath: positionResult.indexPath,
          success: true,
        });
      }
    } catch (err) {
      console.error("❌ Legacy Unsorted processing failed:", err.message);
      if (ENV_VERBOSE) console.error(err);
      errors.push({ type: "Legacy Unsorted", error: err.message });
    }
  } else {
    console.warn("⚠️  Skipping Legacy Unsorted: Position CSV not found.");
  }

  // 3) Legacy Sorted (position-based with detection)
  if (positionCsvPath && fs.existsSync(positionCsvPath)) {
    try {
      await setModbusMode("legacy-sorted", {
        url: gqlUrl,
        accessToken,
        xsrfToken,
        xsrfCookie,
        verbose: ENV_VERBOSE,
      });

      console.log("\n📊 Generating Legacy Sorted Reports…");
      const sortedResult = await csvSortedBatchRead({
        site,
        type: "legacy-tracker",
        csvPath: positionCsvPath,
      });

      if (sortedResult?.error) {
        console.error("❌ Legacy Sorted processing error:", sortedResult.error);
        errors.push({ type: "Legacy Sorted", error: sortedResult.error });
      } else {
        console.log("✅ Legacy Sorted reports generated!");
        console.log(`   • Reports: ${sortedResult.reports.length}`);
        console.log(`   • Index:   ${sortedResult.indexPath}`);
        allResults.push({
          category: "Legacy Sorted",
          reports: sortedResult.reports,
          indexPath: sortedResult.indexPath,
          success: true,
        });
      }
    } catch (err) {
      console.error("❌ Legacy Sorted processing failed:", err.message);
      if (ENV_VERBOSE) console.error(err);
      errors.push({ type: "Legacy Sorted", error: err.message });
    }
  } else {
    console.warn("⚠️  Skipping Legacy Sorted: Position CSV not found.");
  }

  // 4) Master index page
  console.log("\n🧭 Generating Master Index page…");
  const masterIndexPath = path.join(OUT_DIR, `${site}_master_index.html`);
  const html = generateMasterIndex(site, allResults, errors, masterIndexPath);
  fs.writeFileSync(masterIndexPath, html);
  console.log(`✅ Master Index generated: ${masterIndexPath}`);

  // 5) Summary
  console.log("\n==============================================");
  console.log("📋 GENERATION SUMMARY");
  console.log("==============================================");
  console.log(`✅ Successful Categories: ${allResults.length}`);
  console.log(`❌ Failed Categories:     ${errors.length}`);
  console.log(
    `📊 Total Reports:         ${allResults.reduce((sum, cat) => sum + cat.reports.length, 0)}`
  );
  console.log(`🏠 Master Index:          ${masterIndexPath}`);

  if (allResults.length > 0) {
    console.log("\n📁 Generated Categories:");
    for (const cat of allResults) {
      console.log(`   • ${cat.category}: ${cat.reports.length} reports`);
    }
  }
  if (errors.length > 0) {
    console.log("\n❌ Failed Categories:");
    for (const e of errors) console.log(`   • ${e.type}: ${e.error}`);
  }

  return {
    success: allResults.length > 0,
    totalCategories: allResults.length,
    totalReports: allResults.reduce((sum, cat) => sum + cat.reports.length, 0),
    masterIndexPath,
    categories: allResults,
    errors,
  };
}

// 5) Master index page builder (same as before)
function generateMasterIndex(site, allResults, errors, masterIndexPath) {
  const timestamp = new Date().toLocaleString();
  const rel = (to) => {
    const fromDir = path.dirname(masterIndexPath);
    return path.relative(fromDir, to).replace(/\\/g, "/");
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>All Modbus Reports - ${site}</title>
<link rel="icon" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/icons/file-earmark-bar-graph.svg">
<style>
  body{background:linear-gradient(120deg,#f8fafc 0%,#e0e7ef 100%);margin:0;padding:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .container{max-width:1200px;margin:2.5em auto;background:#fff;border-radius:18px;box-shadow:0 6px 32px #b0b8c940,0 1.5px 4px #b0b8c930;padding:2.5em 2em 2em}
  .header{display:flex;align-items:center;gap:1em;margin-bottom:2em;text-align:center;flex-direction:column}
  .header-icon{font-size:3em;color:#16a34a}
  h1{font-size:2.5em;font-weight:700;color:#22223b;margin:0;letter-spacing:1px}
  .subtitle{color:#64748b;font-size:1.1em;margin-top:.5em}
  .stats-bar{display:flex;justify-content:space-between;align-items:center;background:#f1f5f9;padding:1em 1.5em;border-radius:10px;margin-bottom:2em}
  .stat-item{text-align:center}
  .stat-number{font-size:1.5em;font-weight:700;color:#16a34a}
  .stat-label{font-size:.9em;color:#64748b;margin-top:.2em}
  .category-grid{display:grid;gap:2em;margin-top:2em}
  .category-card{background:#f9fafb;border:2px solid #e7fbe9;border-radius:16px;padding:2em;transition:.3s}
  .category-card:hover{border-color:#16a34a;transform:translateY(-3px);box-shadow:0 8px 25px #b0b8c920}
  .category-title{font-size:1.5em;font-weight:700;color:#166534;margin-bottom:1em;display:flex;align-items:center;gap:.5em}
  .category-description{color:#64748b;margin-bottom:1.5em;line-height:1.6}
  .report-grid{display:grid;gap:1em;margin-top:1em}
  .report-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1.2em;transition:.2s}
  .report-card:hover{border-color:#16a34a;transform:translateY(-1px);box-shadow:0 4px 12px #b0b8c920}
  .report-title{font-size:1.1em;font-weight:600;color:#166534;margin-bottom:.5em}
  .report-stats{color:#64748b;font-size:.9em;margin-bottom:1em}
  .report-link{display:inline-block;background:#16a34a;color:#fff;padding:.6em 1em;border-radius:6px;text-decoration:none;font-weight:600;transition:.2s;font-size:.9em}
  .report-link:hover{background:#15803d;transform:translateY(-1px)}
  .error-card{background:#fef2f2;border:2px solid #fecaca;border-radius:16px;padding:2em;margin-bottom:2em}
  .error-title{color:#dc2626;font-size:1.5em;font-weight:700;margin-bottom:1em;display:flex;align-items:center;gap:.5em}
  .error-message{color:#7f1d1d;background:#fef2f2;padding:1em;border-radius:8px;border-left:4px solid #dc2626}
  .home-btn{position:fixed;top:14px;right:14px;width:38px;height:38px;border-radius:50%;background:#fff;color:#166534;display:flex;align-items:center;justify-content:center;text-decoration:none;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,.05);z-index:9999}
  .home-btn:hover{background:#f1f5f9}
  @media(max-width:768px){.container{padding:1.5em 1em}.stats-bar{flex-direction:column;gap:1em}h1{font-size:2em}}
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
</head>
<body>
  <a href="#" class="home-btn" title="Home"><i class="bi bi-house"></i></a>
  <div class="container">
    <div class="header">
      <span class="header-icon"><i class="bi bi-file-earmark-bar-graph"></i></span>
      <h1>All Modbus Reports</h1>
      <div class="subtitle">Site: ${site} | Generated: ${timestamp}</div>
    </div>

    <div class="stats-bar">
      <div class="stat-item"><div class="stat-number">${allResults.length}</div><div class="stat-label">Categories</div></div>
      <div class="stat-item"><div class="stat-number">${allResults.reduce((s,c)=>s+c.reports.length,0)}</div><div class="stat-label">Total Reports</div></div>
      <div class="stat-item"><div class="stat-number">${errors.length}</div><div class="stat-label">Errors</div></div>
    </div>

    ${errors.length ? `
      <div class="error-card">
        <div class="error-title"><i class="bi bi-exclamation-triangle"></i> Generation Errors</div>
        ${errors.map(e => `<div class="error-message"><strong>${e.type}:</strong> ${e.error}</div>`).join("")}
      </div>` : ""}

    <div class="category-grid">
      ${allResults.map(category => `
        <div class="category-card">
          <div class="category-title"><i class="bi bi-collection"></i>${category.category}</div>
          <div class="category-description">
            ${(() => {
              switch (category.category) {
                case "TTID Sorted":
                  return "Reports organized by TTID (Terminal Type ID) with data grouped by device type.";
                case "Legacy Unsorted":
                  return "Position-based reports for Assets and Network Controller devices.";
                case "Legacy Sorted":
                  return "Position-based reports with device type detection.";
                default:
                  return "Modbus data reports with comprehensive device information.";
              }
            })()}
          </div>
          <div class="report-grid">
            ${category.reports.map(r => `
              <div class="report-card">
                <div class="report-title">${r.deviceType || "Report"}</div>
                <div class="report-stats">
                  ${r.ttidsProcessed !== undefined
                    ? `TTIDs: ${r.ttidsProcessed} | Entries: ${r.resultsCount}`
                    : r.positionsProcessed !== undefined
                      ? `Positions: ${r.positionsProcessed} | Entries: ${r.resultsCount}`
                      : `Entries: ${r.resultsCount}`
                  }
                </div>
                <a class="report-link" href="${rel(r.htmlPath)}"><i class="bi bi-eye"></i> View Report</a>
              </div>`).join("")}
          </div>
          <a class="report-link" href="${rel(category.indexPath)}" style="background:#e7fbe9;color:#166534;border:2px solid #16a34a;">
            <i class="bi bi-folder2-open"></i> View All ${category.category} Reports
          </a>
        </div>`).join("")}
    </div>
  </div>
</body>
</html>`;
}

// 6) Export for programmatic use
module.exports = { generateAllReports };

// 7) CLI runner — THIS IS WHAT ENSURES THE SCRIPT ACTUALLY RUNS
if (require.main === module) {
  (async () => {
    try {
      const site = env("SITE", "192.168.12.73");
      const ttidCsv = env("TTID_CSV_PATH", "./sample_ttids.csv");
      const positionCsv = env("POSITION_CSV_PATH", "./sample_positions.csv");
      const result = await generateAllReports(site, ttidCsv, positionCsv);
      if (result.success) {
        console.log("\n🎉 All reports generated successfully!");
        console.log(`📊 Open the master index: ${result.masterIndexPath}`);
      } else {
        console.log("\n⚠️  Generation finished with warnings/errors. See logs above.");
      }
    } catch (err) {
      console.error("❌ Fatal error:", err?.stack || err);
      process.exit(1);
    }
  })();
}
