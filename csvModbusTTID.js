// Load environment variables from .env file
require('dotenv').config();

const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");
const { Parser } = require("json2csv");
const csvParser = require("csv-parser");

// ---------------- Codec helpers ----------------

const CODEC_ALIASES = {
  asciiz: "ascii", utf8: "ascii", text: "ascii", string: "ascii",
  float: "float32", floatbe: "float32", float32: "float32",
  int: "int32", int32: "int32", i32: "int32",
  uint: "uint32", u32: "uint32", uint32: "uint32",
  u64: "uint64", uint64: "uint64",
  int64: "int64", i64: "int64",
  int16: "int16", i16: "int16", s16: "int16",
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
    case "ascii":
      return buffer.toString("utf8").replace(/\0/g, "");
    case "float32":
      return buffer.length >= 4 ? buffer.readFloatBE(0) : "Not enough bytes for float32";
    case "int32":
      return buffer.length >= 4 ? buffer.readInt32BE(0) : "Not enough bytes for int32";
    case "uint32":
      return buffer.length >= 4 ? buffer.readUInt32BE(0) : "Not enough bytes for uint32";
    case "uint64":
      return buffer.length >= 8 ? BigInt("0x" + hex).toString() : "Not enough bytes for uint64";
    case "int64":
      return "Int64 decoding not implemented";
    case "int16":
      return buffer.length >= 2 ? buffer.readInt16BE(0) : "Not enough bytes for int16";
    case "uint16":
      return buffer.length >= 2 ? buffer.readUInt16BE(0) : "Not enough bytes for uint16";
    case "boolean":
      return buffer.length >= 2 ? (buffer.readUInt16BE(0) !== 0 ? 1 : 0) : "Not enough bytes for boolean";
    case "hex":
      return "0x" + hex.toUpperCase();
    default:
      return null;
  }
}

// ---------------- Paths & IO helpers ----------------

const jsonDir = (process?.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "json")))
  ? path.join(process.resourcesPath, "json")
  : path.join(__dirname, "json");

const UNSORTED_ASSETS_SPEC_PATH = path.join(jsonDir, "unsorted_assets.json");
const UNSORTED_NC_SPEC_PATH     = path.join(jsonDir, "unsorted_nc.json");

function parseTTIDsFromCSV(csvPath) {
  return new Promise((resolve, reject) => {
    const TTIDs = [];
    fs.createReadStream(csvPath)
      .pipe(csvParser())
      .on("data", (row) => {
        if (row.TTID) TTIDs.push(String(row.TTID).trim());
      })
      .on("end", () => resolve(TTIDs))
      .on("error", reject);
  });
}

// ---------------- Address math per your rules ----------------

/** Unit IDs by device type */
function computeUnitId(deviceType, ttidNum) {
  const t = String(deviceType || "").toLowerCase();
  if (t === "row") {
    if (!Number.isInteger(ttidNum) || ttidNum < 1) throw new Error(`Invalid TTID for row boxes: ${ttidNum}`);
    return Math.floor((ttidNum - 1) / 100) + 1;
  }
  if (t === "weather") return 101;
  if (t === "repeater") return 102;
  if (t === "network") return 100;
  throw new Error(`Unknown device type: ${deviceType}`);
}

/** Starting address per device type */
function computeStartingAddressForType(deviceType, ttidNum, unitId, baseReg) {
  const t = String(deviceType || "").toLowerCase();
  if (t === "row") {
    // Row Boxes: banked by Unit
    return ((ttidNum - 1) - ((unitId - 1) * 100)) * 512 + baseReg;
  }
  // NC / Weather / Repeater: straight TTID paging
  return (ttidNum - 1) * 512 + baseReg;
}

// ---------------- Main module ----------------

/**
 * Reads modbus data for Row Boxes, Weather, Repeater, and Network Controller
 * using a single per-type field spec:
 *  - row/weather/repeater => json/unsorted_assets.json
 *  - network controller   => json/unsorted_nc.json
 *
 * @param {{site:string, TYPE?:string}} device
 * @param {string} csvFilePath - CSV containing a TTID column
 * @returns {Promise<{message?:string, reports?:any[], indexPath?:string, error?:string}>}
 */
module.exports = async function readModbusBatch(device, csvFilePath) {
  const client = new ModbusRTU();

  try {
    const { site, TYPE } = device;
    const normalizedType = (TYPE || "row").toLowerCase();

    // Device categories to generate
    const deviceTypes = [
      { name: "Row Boxes",          type: "row",      ttids: [] },
      { name: "Weather Station",    type: "weather",  ttids: [] },
      { name: "Repeater",           type: "repeater", ttids: [] },
      { name: "Network Controller", type: "network",  ttids: [1] }, // NC uses TTID=1 by your convention
    ];

    // Parse TTIDs for non-NC devices from CSV
    const csvTTIDs = await parseTTIDsFromCSV(csvFilePath);
    deviceTypes[0].ttids = csvTTIDs; // Row Boxes
    deviceTypes[1].ttids = csvTTIDs; // Weather
    deviceTypes[2].ttids = csvTTIDs; // Repeater

    // Load specs (validate presence)
    if (!fs.existsSync(UNSORTED_ASSETS_SPEC_PATH)) {
      throw new Error(`Spec not found: ${UNSORTED_ASSETS_SPEC_PATH}`);
    }
    if (!fs.existsSync(UNSORTED_NC_SPEC_PATH)) {
      throw new Error(`Spec not found: ${UNSORTED_NC_SPEC_PATH}`);
    }

    const allReports = [];

    // Connect once per run
    await client.connectTCP(site, { port: 502 });

    for (const deviceType of deviceTypes) {
      if (deviceType.ttids.length === 0) continue;

      // Choose the correct spec for this device type
      const fieldSpec = (deviceType.type === "network")
        ? JSON.parse(fs.readFileSync(UNSORTED_NC_SPEC_PATH, "utf8"))
        : JSON.parse(fs.readFileSync(UNSORTED_ASSETS_SPEC_PATH, "utf8"));

      const allResults = [];

      for (const TTID of deviceType.ttids) {
        const ttidNum = Number(String(TTID).trim());
        if (!Number.isFinite(ttidNum)) {
          allResults.push({
            TTID, Site: site, UnitID: "", ID: "", StartingAddress: "",
            Size: "", CombinedHex: "Invalid TTID", DecodedValue: ""
          });
          continue;
        }

        let unitId;
        try {
          unitId = computeUnitId(deviceType.type, ttidNum);
        } catch (err) {
          allResults.push({
            TTID, Site: site, UnitID: "", ID: "", StartingAddress: "",
            Size: "", CombinedHex: `Error: ${err.message}`, DecodedValue: ""
          });
          continue;
        }

        // Iterate through the chosen spec
        for (const field of fieldSpec) {
          const baseReg = Number(field.BaseReg);
          const size = Number(field.Size);
          const id = field.ID || "";
          const rawCodec = field.Codec || "";

          if (!Number.isFinite(baseReg) || !Number.isFinite(size) || size <= 0) {
            allResults.push({
              TTID: ttidNum, Site: site, UnitID: unitId, ID: id,
              StartingAddress: baseReg, Size: size,
              CombinedHex: "Invalid field spec", DecodedValue: ""
            });
            continue;
          }

          const startAddr = computeStartingAddressForType(deviceType.type, ttidNum, unitId, baseReg);

          client.setID(unitId);
          try {
            const data = await client.readHoldingRegisters(startAddr, size);
            const hexValues = data.data.map((val) =>
              (val < 0 ? 0x10000 + val : val).toString(16).padStart(4, "0")
            );
            let combinedHex = hexValues.join("").replace(/^0+/, "") || "00";

            const normalizedCodec = normalizeCodec(rawCodec);

            // Pad to expected widths for decoders
            if (["uint64"].includes(normalizedCodec) && combinedHex.length < 16) {
              combinedHex = combinedHex.padStart(16, "0");
            }
            if (["uint32", "int32", "float32"].includes(normalizedCodec) && combinedHex.length < 8) {
              combinedHex = combinedHex.padStart(8, "0");
            }
            if (["uint16", "int16", "boolean"].includes(normalizedCodec) && combinedHex.length < 4) {
              combinedHex = combinedHex.padStart(4, "0");
            }

            let decodedValue;
            try {
              decodedValue = decodeValue(combinedHex, normalizedCodec);
              if (decodedValue === null && rawCodec) {
                decodedValue = `Unknown codec "${rawCodec}"`;
              }
            } catch (err) {
              decodedValue = `Decode error: ${err.message}`;
            }

            allResults.push({
              TTID: ttidNum,
              Site: site,
              UnitID: unitId,
              ID: id,
              StartingAddress: startAddr,
              Size: size,
              CombinedHex: `'${String(combinedHex).toUpperCase()}`,
              DecodedValue: decodedValue
            });

          } catch (err) {
            allResults.push({
              TTID: ttidNum, Site: site, UnitID: unitId, ID: id,
              StartingAddress: startAddr, Size: size,
              CombinedHex: `Error: ${err.message}`, DecodedValue: ""
            });
          }
        }
      }

      // ------- Output per device type -------

      const parser = new Parser({
        fields: ["TTID", "ID", "Site", "UnitID", "StartingAddress", "Size", "CombinedHex", "DecodedValue"],
      });
      const csv = parser.parse(allResults);

      const outputDir = path.resolve(__dirname, "modbus_csv_outputs");
      const ttidSortedDir = path.join(outputDir, "ttid_sorted");
      if (!fs.existsSync(ttidSortedDir)) fs.mkdirSync(ttidSortedDir, { recursive: true });

      const outputPath = path.join(ttidSortedDir, `${site}_${deviceType.type}_modbus_data.csv`);
      fs.writeFileSync(outputPath, csv);

      // HTML per device type
      const htmlOutputPath = outputPath.replace(/\.csv$/i, ".html");
      const htmlHeader = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modbus ${deviceType.name} Report</title>
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
    .ttid-section { margin-top: 2.5em; margin-bottom: 2em; }
    .ttid-header { background: linear-gradient(90deg, #bbf7d0 60%, #d1fae5 100%); color: #166534; font-size: 1.2em; font-weight: 700; border-radius: 8px; padding: 0.5em 1.2em; margin-bottom: 0.7em; box-shadow: 0 1px 4px #b0b8c920; letter-spacing: 0.5px; display: inline-block; }
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
    .badge-success.decodedvalue-badge { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; font-family: inherit; word-break: break-word; white-space: pre-wrap; display: inline-block; text-align: left; vertical-align: top; margin: 0; padding: 0.2em 0.4em; line-height: 1.3; }
    .home-btn { position: fixed; top: 14px; right: 14px; width: 38px; height: 38px; border-radius: 50%; background: #ffffff; color: #166534; display: flex; align-items: center; justify-content: center; text-decoration: none; border: 1px solid #e2e8f0; box-shadow: 0 2px 8px rgba(0,0,0,0.05); z-index: 9999; }
    .home-btn:hover { background: #f1f5f9; }
    @media (max-width: 800px) {
      .container { padding: 1em 0.2em; }
      .nav-links { flex-direction: column; }
      table, thead, tbody, th, td, tr { display: block; }
      th { position: absolute; left: -9999px; top: -9999px; }
      tr { margin-bottom: 1.2em; border-radius: 10px; box-shadow: 0 1px 4px #b0b8c920; }
      td { border: none; position: relative; padding-left: 50%; min-height: 2.2em; text-align: left !important; }
      td:before { position: absolute; left: 1em; top: 0.8em; width: 45%; white-space: nowrap; font-weight: 600; color: #16a34a; }
      td:nth-of-type(1):before { content: 'TTID'; }
      td:nth-of-type(2):before { content: 'ID'; }
      td:nth-of-type(3):before { content: 'Site'; }
      td:nth-of-type(4):before { content: 'UnitID'; }
      td:nth-of-type(5):before { content: 'StartingAddress'; }
      td:nth-of-type(6):before { content: 'Size'; }
      td:nth-of-type(7):before { content: 'CombinedHex'; }
      td:nth-of-type(8):before { content: 'DecodedValue'; text-align: right !important; }
    }
  </style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
</head>
<body>
  <a href="../${site}_master_index.html" class="home-btn" title="Home"><i class="bi bi-house"></i></a>
  <div class="container">
    <div class="header"><span class="header-icon"><i class="bi bi-file-earmark-bar-graph"></i></span><h1>Modbus ${deviceType.name} Report</h1></div>
    <div class="nav-links">
      <a href="${site}_row_modbus_data.html" class="nav-link${deviceType.type === 'row' ? ' active' : ''}">Row Boxes</a>
      <a href="${site}_weather_modbus_data.html" class="nav-link${deviceType.type === 'weather' ? ' active' : ''}">Weather Station</a>
      <a href="${site}_repeater_modbus_data.html" class="nav-link${deviceType.type === 'repeater' ? ' active' : ''}">Repeater</a>
      <a href="${site}_network_modbus_data.html" class="nav-link${deviceType.type === 'network' ? ' active' : ''}">Network Controller</a>
    </div>
`;
      const htmlFooter = `  </div>\n</body>\n</html>`;

      // Group rows by TTID for HTML
      const groupedByTTID = {};
      allResults.forEach(row => {
        if (row.TTID && row.ID) {
          if (!groupedByTTID[row.TTID]) groupedByTTID[row.TTID] = [];
          groupedByTTID[row.TTID].push(row);
        }
      });

      let htmlRows = "";
      Object.keys(groupedByTTID).forEach(ttid => {
        const rows = groupedByTTID[ttid];
        htmlRows += `<div class="ttid-section">`;
        htmlRows += `<div class="ttid-header">TTID: ${ttid}</div>`;
        htmlRows += `<table><thead><tr><th>TTID</th><th>ID</th><th>Site</th><th>UnitID</th><th>StartingAddress</th><th>Size</th><th>CombinedHex</th><th>DecodedValue</th></tr></thead><tbody>`;
        rows.forEach(row => {
          const isError = String(row.CombinedHex).toLowerCase().includes("error");
          let combinedHexCell = (row.CombinedHex ?? "").toString().replace(/^'/, "");
          let decodedValueCell = (row.DecodedValue ?? "");
          if (isError && decodedValueCell) {
            decodedValueCell = `<span class="badge badge-error">${decodedValueCell}</span>`;
          } else if (decodedValueCell !== "") {
            decodedValueCell = `<span class="badge badge-success decodedvalue-badge">${decodedValueCell}</span>`;
          }
          htmlRows += `<tr${isError ? ' class="error"' : ''}><td>${row.TTID ?? ""}</td><td>${row.ID ?? ""}</td><td>${row.Site ?? ""}</td><td>${row.UnitID ?? ""}</td><td>${row.StartingAddress ?? ""}</td><td>${row.Size ?? ""}</td><td class="combinedhex-cell">${combinedHexCell}</td><td class="decodedvalue-cell">${decodedValueCell}</td></tr>`;
        });
        htmlRows += `</tbody></table></div>`;
      });

      fs.writeFileSync(htmlOutputPath, `${htmlHeader}\n${htmlRows}\n${htmlFooter}`);

      allReports.push({
        deviceType: deviceType.name,
        type: deviceType.type,
        csvPath: outputPath,
        htmlPath: htmlOutputPath,
        ttidsProcessed: deviceType.ttids.length,
        resultsCount: allResults.length
      });
    }

    // Index page
    const indexHtmlPath = path.join(path.resolve(__dirname, "modbus_csv_outputs"), "ttid_sorted", `${site}_index.html`);
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modbus Reports Index - ${site}</title>
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
    .home-btn { position: fixed; top: 14px; right: 14px; width: 38px; height: 38px; border-radius: 50%; background: #ffffff; color: #166534; display: flex; align-items: center; justify-content: center; text-decoration: none; border: 1px solid #e2e8f0; box-shadow: 0 2px 8px rgba(0,0,0,0.05); z-index: 9999; }
    .home-btn:hover { background: #f1f5f9; }
    @media (max-width: 600px) {
      .container { padding: 1em; }
      .report-grid { grid-template-columns: 1fr; }
    }
  </style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
</head>
<body>
  <a href="../${site}_master_index.html" class="home-btn" title="Home"><i class="bi bi-house"></i></a>
  <div class="container">
    <div class="header"><span class="header-icon"><i class="bi bi-file-earmark-bar-graph"></i></span><h1>Modbus Reports Index</h1></div>
    <p style="color: #64748b; margin-bottom: 2em;">Site: ${site} | Generated: ${new Date().toLocaleString()}</p>
    <div class="report-grid">
      ${allReports.map(report => `
        <div class="report-card">
          <div class="report-title">${report.deviceType}</div>
          <div class="report-stats">TTIDs: ${report.ttidsProcessed} | Entries: ${report.resultsCount}</div>
          <a href="${path.basename(report.htmlPath)}" class="report-link">View Report</a>
        </div>
      `).join('')}
    </div>
  </div>
</body>
</html>`;
    fs.writeFileSync(indexHtmlPath, indexHtml);

    return {
      message: `Generated ${allReports.length} reports for ${site}`,
      reports: allReports,
      indexPath: indexHtmlPath
    };

  } catch (err) {
    return { error: `Modbus read failed: ${err.message}` };
  } finally {
    try { client.close(); } catch {}
  }
};
