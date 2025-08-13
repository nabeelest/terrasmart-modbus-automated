// Load environment variables from .env file
require('dotenv').config();

const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");
const { Parser } = require("json2csv");
const csvParser = require("csv-parser");

const CODEC_ALIASES = {
  asciiz: "ascii", utf8: "ascii", text: "ascii", string: "ascii",
  float: "float32", floatbe: "float32", float32: "float32",
  int: "int32", int32: "int32", i32: "int32",
  uint: "uint32", u32: "uint32", uint32: "uint32",
  u64: "uint64", uint64: "uint64",
  int64: "int64", i64: "int64",
  int16: "int16", s16: "int16", i16: "int16",
  uint16: "uint16", u16: "uint16",
  bool: "boolean", boolean: "boolean",
  hex: "hex",
};

function normalizeCodec(codec) {
  const key = String(codec || "").toLowerCase().replace(/\s+/g, "");
  return CODEC_ALIASES[key] || key;
}

function decodeValue(hex, codec) {
  const buffer = Buffer.from(hex, "hex");
  switch (codec) {
    case "ascii": return buffer.toString("utf8").replace(/\0/g, "");
    case "float32": return buffer.length >= 4 ? buffer.readFloatBE(0) : "Not enough bytes";
    case "int32": return buffer.length >= 4 ? buffer.readInt32BE(0) : "Not enough bytes";
    case "uint32": return buffer.length >= 4 ? buffer.readUInt32BE(0) : "Not enough bytes";
    case "uint64": return buffer.length >= 8 ? BigInt("0x" + hex).toString() : "Not enough bytes";
    case "int64": return "Int64 decoding not implemented";
    case "int16": return buffer.length >= 2 ? buffer.readInt16BE(0) : "Not enough bytes";
    case "uint16": return buffer.length >= 2 ? buffer.readUInt16BE(0) : "Not enough bytes";
    case "boolean": return buffer.length >= 2 ? (buffer.readUInt16BE(0) !== 0 ? 1 : 0) : "Not enough bytes";
    case "hex": return "0x" + hex.toUpperCase();
    default: return null;
  }
}

function parseCSVPositions(filePath) {
  return new Promise((resolve, reject) => {
    const positions = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on("data", row => {
        if (row.Position !== undefined) {
          const pos = Number(row.Position);
          if (!isNaN(pos)) positions.push(pos);
        }
      })
      .on("end", () => resolve(positions))
      .on("error", reject);
  });
}

module.exports = async function readAllPositionsFromCsv({ site, type, csvPath }) {
  const client = new ModbusRTU();

  if (!site || typeof site !== "string" || !site.trim()) throw new Error("❌ Invalid site");

  // Define device types to process
  const deviceTypes = [
    { name: "Row Boxes", type: "legacy-tracker", unitId: 1, jsonFile: "unsorted_assets.json", positions: [] },
    { name: "Weather Station", type: "legacy-weather", unitId: 3, jsonFile: "unsorted_assets.json", positions: [] },
    { name: "Network Controller", type: "legacy-network", unitId: 0, jsonFile: "unsorted_nc.json", positions: [0] } // NC always uses position 0
  ];

  // Parse positions from CSV for non-NC devices
  const csvPositions = await parseCSVPositions(csvPath);
  console.log(`Found ${csvPositions.length} positions in CSV:`, csvPositions);
  deviceTypes[0].positions = csvPositions; // Row Boxes
  deviceTypes[1].positions = csvPositions; // Weather Station
  // NC keeps positions: [0]

  const allReports = [];

  for (const deviceType of deviceTypes) {
    console.log(`Processing ${deviceType.name} with ${deviceType.positions.length} positions`);
    if (deviceType.positions.length === 0) {
      console.log(`Skipping ${deviceType.name} - no positions to process`);
      continue;
    }

    const jsonFilename = deviceType.jsonFile;
    const jsonPath = process?.resourcesPath &&
      fs.existsSync(path.join(process.resourcesPath, "json", jsonFilename))
        ? path.join(process.resourcesPath, "json", jsonFilename)
        : path.join(__dirname, "json", jsonFilename);

    const entries = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const typeIdKey = jsonFilename.includes("nc") ? "System ID" : "Device Type";
    const typeEntry = entries.find(item => item.ID?.trim().toLowerCase() === typeIdKey.toLowerCase());

    await client.connectTCP(site, { port: 502 });
    client.setID(deviceType.unitId);

    const allResults = [];

    for (const pos of deviceType.positions) {
      const posBase = Number(pos);

      // Read device type
      let deviceTypeName = "Unknown";
      if (typeEntry && !isNaN(typeEntry.BaseReg) && !isNaN(typeEntry.Size)) {
        try {
          const start = posBase * 512 + typeEntry.BaseReg;
          const data = await client.readHoldingRegisters(start, typeEntry.Size);
          const hexValues = data.data.map(val =>
            (val < 0 ? 0x10000 + val : val).toString(16).padStart(4, "0")
          );
          const combinedHex = hexValues.join("");
          const codec = normalizeCodec(typeEntry.Codec);
          deviceTypeName = decodeValue(combinedHex, codec) || "Unknown";
        } catch (err) {
          deviceTypeName = `Error: ${err.message}`;
        }
      }

      // Add aesthetic section header
      allResults.push({
        ID: `======================Position: ${pos} | DeviceType: ${deviceTypeName} ======================`,
        Site: "", UnitID: "", StartingAddress: "", Size: "", CombinedHex: "", DecodedValue: ""
      });

      for (const entry of entries) {
        const { ID, BaseReg, Size, Codec = "" } = entry;
        if (!ID || isNaN(BaseReg) || isNaN(Size)) continue;

        try {
          const start = posBase * 512 + BaseReg;
          const data = await client.readHoldingRegisters(start, Size);
          const values = data.data;
          const hexValues = values.map((val) =>
            (val < 0 ? 0x10000 + val : val).toString(16).padStart(4, "0")
          );
          let combinedHex = hexValues.join("");
          const normalizedCodec = normalizeCodec(Codec);

          if (["uint64"].includes(normalizedCodec) && combinedHex.length < 16) combinedHex = combinedHex.padStart(16, "0");
          if (["uint32", "int32", "float32"].includes(normalizedCodec) && combinedHex.length < 8) combinedHex = combinedHex.padStart(8, "0");
          if (["uint16", "int16", "boolean"].includes(normalizedCodec) && combinedHex.length < 4) combinedHex = combinedHex.padStart(4, "0");

          const decoded = decodeValue(combinedHex, normalizedCodec);

          allResults.push({
            Site: site,
            UnitID: deviceType.unitId,
            ID,
            StartingAddress: start,
            Size,
            CombinedHex: "'" + combinedHex.toUpperCase(),
            DecodedValue: decoded,
          });
        } catch (err) {
          allResults.push({
            Site: site,
            UnitID: deviceType.unitId,
            ID,
            StartingAddress: posBase * 512 + entry.BaseReg,
            Size: entry.Size,
            CombinedHex: `Error: ${err.message}`,
            DecodedValue: "",
          });
        }
      }

      allResults.push({
        ID: "=".repeat(100),
        Site: "", UnitID: "", StartingAddress: "", Size: "", CombinedHex: "", DecodedValue: ""
      });

      allResults.push({ ID: "", Site: "", UnitID: "", StartingAddress: "", Size: "", CombinedHex: "", DecodedValue: "" });
    }

    // Generate CSV
    const parser = new Parser({
      fields: ["ID", "Site", "UnitID", "StartingAddress", "Size", "CombinedHex", "DecodedValue"]
    });

    const csvData = parser.parse(allResults);
    
    const outputDir = path.resolve(__dirname, "modbus_csv_outputs");
    const legacySortedDir = path.join(outputDir, "legacy_sorted");
    if (!fs.existsSync(legacySortedDir)) {
      fs.mkdirSync(legacySortedDir, { recursive: true });
    }

    const outputPath = path.join(legacySortedDir, `${site}_${deviceType.type}_multiPos.csv`);
    fs.writeFileSync(outputPath, csvData);

    // Generate HTML report
    const htmlOutputPath = outputPath.replace(/\.csv$/i, ".html");
    const htmlHeader = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modbus ${deviceType.name} Legacy Sorted Report</title>
  <link rel="icon" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/icons/file-earmark-bar-graph.svg">
  <style>
    body { background: linear-gradient(120deg, #f8fafc 0%, #e0e7ef 100%); margin: 0; padding: 0; min-height: 100vh; }
    .container { max-width: 1100px; margin: 2.5em auto; background: #fff; border-radius: 18px; box-shadow: 0 6px 32px #b0b8c940, 0 1.5px 4px #b0b8c930; padding: 2.5em 2em 2em 2em; }
    .header { display: flex; align-items: center; gap: 1em; margin-bottom: 2em; }
    .header-icon { font-size: 2.5em; color: #16a34a; }
    h1 { font-size: 2.2em; font-weight: 700; color: #22223b; margin: 0; letter-spacing: 1px; }
    .nav-links { display: flex; gap: 1em; margin-bottom: 2em; flex-wrap: wrap; }
    .nav-link { background: #e7fbe9; color: #166534; padding: 0.5em 1em; border-radius: 6px; text-decoration: none; font-weight: 600; transition: all 0.2s; }
    .nav-link:hover { background: #bbf7d0; transform: translateY(-1px); }
    .nav-link.active { background: #16a34a; color: white; }
    .section { margin-top: 2.5em; margin-bottom: 2em; }
    .section-header { background: linear-gradient(90deg, #bbf7d0 60%, #d1fae5 100%); color: #166534; font-size: 1.2em; font-weight: 700; border-radius: 8px; padding: 0.5em 1.2em; margin-bottom: 0.7em; box-shadow: 0 1px 4px #b0b8c920; letter-spacing: 0.5px; display: inline-block; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; background: #f9fafb; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px #b0b8c920; margin-bottom: 1.5em; table-layout: fixed; }
    th, td { padding: 0.65em 0.6em; }
    th { background: #e7fbe9; color: #166534; font-weight: 600; border-bottom: 1px solid #bbf7d0; text-align: left; }
    th:last-child, td:last-child { text-align: right; }
    td { color: #3a3a40; font-size: 1em; border-bottom: 1px solid #f1f5f9; text-align: left; vertical-align: top; }
    td:last-child { text-align: right; }
    td.combinedhex-cell { max-width: 220px; min-width: 120px; word-break: break-all; overflow-wrap: break-word; font-family: 'Fira Mono', 'Consolas', 'Menlo', monospace; background: none; border: none; border-radius: 0; padding: 0.3em 0.5em; }
    td.decodedvalue-cell { max-width: 260px; word-break: break-word; overflow-wrap: break-word; }
    tr { transition: background 0.2s; }
    tr:hover:not(.error) { background: #f3fdf6; }
    tr.error td { background: #ffeaea !important; color: #b00; }
    .badge { display: inline-block; padding: 0.15em 0.5em; border-radius: 5px; font-size: 0.97em; font-weight: 600; letter-spacing: 0.5px; }
    .badge-error { background: #ffeaea; color: #b00; border: 1px solid #fca5a5; }
    .badge-success.decodedvalue-badge { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; font-family: inherit; word-break: break-word; overflow-wrap: break-word; white-space: pre-wrap; display: inline-block; text-align: left; vertical-align: top; margin: 0; padding: 0.2em 0.4em; line-height: 1.3; }
    @media (max-width: 800px) {
      .container { padding: 1em 0.2em; }
      .nav-links { flex-direction: column; }
      table, thead, tbody, th, td, tr { display: block; }
      th { position: absolute; left: -9999px; top: -9999px; }
      tr { margin-bottom: 1.2em; border-radius: 10px; box-shadow: 0 1px 4px #b0b8c920; }
      td { border: none; position: relative; padding-left: 50%; min-height: 2.2em; text-align: left !important; }
      td:before { position: absolute; left: 1em; top: 0.8em; width: 45%; white-space: nowrap; font-weight: 600; color: #16a34a; }
      td:nth-of-type(1):before { content: 'ID'; }
      td:nth-of-type(2):before { content: 'Site'; }
      td:nth-of-type(3):before { content: 'UnitID'; }
      td:nth-of-type(4):before { content: 'StartingAddress'; }
      td:nth-of-type(5):before { content: 'Size'; }
      td:nth-of-type(6):before { content: 'CombinedHex'; }
      td:nth-of-type(7):before { content: 'DecodedValue'; text-align: right !important; }
    }
    .home-btn { position: fixed; top: 16px; right: 16px; background: #16a34a; color: #ffffff; padding: 0.55em 0.95em; border-radius: 8px; text-decoration: none; font-weight: 600; box-shadow: 0 4px 12px #b0b8c920; z-index: 9999; }
    .home-btn:hover { background: #15803d; transform: translateY(-1px); }
    .home-btn { position: fixed; top: 14px; right: 14px; width: 38px; height: 38px; border-radius: 50%; background: #ffffff; color: #166534; display: flex; align-items: center; justify-content: center; text-decoration: none; border: 1px solid #e2e8f0; box-shadow: 0 2px 8px rgba(0,0,0,0.05); z-index: 9999; }
    .home-btn:hover { background: #f1f5f9; }
  </style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
</head>
<body>
  <a href="../${site}_master_index.html" class="home-btn" title="Home"><i class="bi bi-house"></i></a>
  <div class="container">
    <div class="header"><span class="header-icon"><i class="bi bi-file-earmark-bar-graph"></i></span><h1>Modbus ${deviceType.name} Legacy Sorted Report</h1></div>
    <div class="nav-links">
      <a href="${site}_legacy-tracker_multiPos.html" class="nav-link${deviceType.type === 'legacy-tracker' ? ' active' : ''}">Row Boxes</a>
      <a href="${site}_legacy-weather_multiPos.html" class="nav-link${deviceType.type === 'legacy-weather' ? ' active' : ''}">Weather Station</a>
      <a href="${site}_legacy-network_multiPos.html" class="nav-link${deviceType.type === 'legacy-network' ? ' active' : ''}">Network Controller</a>
    </div>\n`;
    const htmlFooter = `  </div>\n</body>\n</html>`;

    // Build sections grouped by Position headers
    let htmlRows = "";
    let currentHeader = null;
    let sectionRows = [];
    function flushSection() {
      if (sectionRows.length > 0 && currentHeader) {
        htmlRows += `<div class="section">`;
        htmlRows += `<div class="section-header">${currentHeader}</div>`;
        htmlRows += `<table><thead><tr><th>ID</th><th>Site</th><th>UnitID</th><th>StartingAddress</th><th>Size</th><th>CombinedHex</th><th>DecodedValue</th></tr></thead><tbody>`;
        htmlRows += sectionRows.join("\n");
        htmlRows += `</tbody></table></div>`;
        sectionRows = [];
      }
    }

    allResults.forEach(row => {
      const idVal = row.ID || "";
      if (typeof idVal === 'string' && idVal.startsWith("=") && idVal.includes("Position:")) {
        flushSection();
        currentHeader = idVal.replace(/^=+\s*/, "").replace(/\s*=+$/, "");
        return;
      }
      // Skip separator and blank rows
      if (typeof idVal === 'string' && /^=+$/.test(idVal)) return;
      if (!row.ID && !row.Site && !row.UnitID && !row.StartingAddress && !row.Size && !row.CombinedHex && !row.DecodedValue) return;

      const isError = String(row.CombinedHex).toLowerCase().includes("error") || String(row.CombinedHex).toLowerCase().includes("no matching entry") || String(row.CombinedHex).toLowerCase().includes("invalid address");

      // HTML-only formatting: strip leading quote from CombinedHex
      const combinedHexCell = (row.CombinedHex !== undefined && row.CombinedHex !== null)
        ? String(row.CombinedHex).replace(/^'/, "")
        : "";
      let decodedValueCell = (row.DecodedValue !== undefined && row.DecodedValue !== null) ? row.DecodedValue : "";

      if (isError && decodedValueCell) {
        decodedValueCell = `<span class="badge badge-error">${decodedValueCell}</span>`;
      } else if (decodedValueCell !== "") {
        decodedValueCell = `<span class="badge badge-success decodedvalue-badge">${decodedValueCell}</span>`;
      }

      sectionRows.push(`<tr${isError ? ' class="error"' : ''}><td>${row.ID !== undefined && row.ID !== null ? row.ID : ""}</td><td>${row.Site !== undefined && row.Site !== null ? row.Site : ""}</td><td>${row.UnitID !== undefined && row.UnitID !== null ? row.UnitID : ""}</td><td>${row.StartingAddress !== undefined && row.StartingAddress !== null ? row.StartingAddress : ""}</td><td>${row.Size !== undefined && row.Size !== null ? row.Size : ""}</td><td class="combinedhex-cell">${combinedHexCell}</td><td class="decodedvalue-cell">${decodedValueCell}</td></tr>`);
    });
    flushSection();

    const htmlContent = `${htmlHeader}\n${htmlRows}\n${htmlFooter}`;
    fs.writeFileSync(htmlOutputPath, htmlContent);

    allReports.push({
      deviceType: deviceType.name,
      type: deviceType.type,
      csvPath: outputPath,
      htmlPath: htmlOutputPath,
      positionsProcessed: deviceType.positions.length,
      resultsCount: allResults.length
    });
  }

  // Generate index page
  const indexHtmlPath = path.join(path.resolve(__dirname, "modbus_csv_outputs"), "legacy_sorted", `${site}_index.html`);
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modbus Legacy Sorted Reports Index - ${site}</title>
  <link rel="icon" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/icons/file-earmark-bar-graph.svg">
  <style>
    body { background: linear-gradient(120deg, #f8fafc 0%, #e0e7ef 100%); margin: 0; padding: 0; min-height: 100vh; }
    .container { max-width: 800px; margin: 2.5em auto; background: #fff; border-radius: 18px; box-shadow: 0 6px 32px #b0b8c940, 0 1.5px 4px #b0b8c930; padding: 2.5em 2em 2em 2em; }
    .header { display: flex; align-items: center; gap: 1em; margin-bottom: 2em; }
    .header-icon { font-size: 2.5em; color: #16a34a; }
    h1 { font-size: 2.2em; font-weight: 700; color: #22223b; margin: 0; letter-spacing: 1px; }
    .report-grid { display: grid; gap: 1.5em; margin-top: 2em; }
    .report-card { background: #f9fafb; border: 2px solid #e7fbe9; border-radius: 12px; padding: 1.5em; transition: all 0.2s; }
    .report-card:hover { border-color: #16a34a; transform: translateY(-2px); box-shadow: 0 4px 12px #b0b8c920; }
    .report-title { font-size: 1.3em; font-weight: 700; color: #166534; margin-bottom: 0.5em; }
    .report-stats { color: #64748b; font-size: 0.9em; margin-bottom: 1em; }
    .report-link { display: inline-block; background: #16a34a; color: white; padding: 0.7em 1.2em; border-radius: 6px; text-decoration: none; font-weight: 600; transition: all 0.2s; }
    .report-link:hover { background: #15803d; transform: translateY(-1px); }
    @media (max-width: 600px) {
      .container { padding: 1em; }
      .report-grid { grid-template-columns: 1fr; }
    }
    .home-btn { position: fixed; top: 14px; right: 14px; width: 38px; height: 38px; border-radius: 50%; background: #ffffff; color: #166534; display: flex; align-items: center; justify-content: center; text-decoration: none; border: 1px solid #e2e8f0; box-shadow: 0 2px 8px rgba(0,0,0,0.05); z-index: 9999; }
    .home-btn:hover { background: #f1f5f9; }
  </style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
</head>
<body>
  <a href="../${site}_master_index.html" class="home-btn" title="Home"><i class="bi bi-house"></i></a>
  <div class="container">
    <div class="header"><span class="header-icon"><i class="bi bi-file-earmark-bar-graph"></i></span><h1>Modbus Legacy Sorted Reports Index</h1></div>
    <p style="color: #64748b; margin-bottom: 2em;">Site: ${site} | Generated: ${new Date().toLocaleString()}</p>
    <div class="report-grid">
      ${allReports.map(report => `
        <div class="report-card">
          <div class="report-title">${report.deviceType}</div>
          <div class="report-stats">Positions: ${report.positionsProcessed} | Entries: ${report.resultsCount}</div>
          <a href="${path.basename(report.htmlPath)}" class="report-link">View Report</a>
        </div>
      `).join('')}
    </div>
  </div>
</body>
</html>`;
  fs.writeFileSync(indexHtmlPath, indexHtml);

  return {
    message: `Generated ${allReports.length} legacy sorted reports for ${site}`,
    reports: allReports,
    indexPath: indexHtmlPath
  };
};
