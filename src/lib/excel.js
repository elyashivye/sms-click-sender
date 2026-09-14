// Read contacts from a File (.xlsx/.xls/.csv) into headers + row objects,
// entirely in the browser (via SheetJS) - nothing is ever uploaded anywhere.
// Every column header becomes an available {placeholder} for the message
// template, so the caller never has to know column names in advance.

import * as XLSX from "xlsx";

const PHONE_HEADER_HINTS = [
  "טלפון", "נייד", "פלאפון", "מספר טלפון", "מספר נייד",
  "phone", "mobile", "cell", "tel",
];

function dedupeHeaders(rawHeaders) {
  const seen = new Map();
  return rawHeaders.map((raw, i) => {
    let name = (raw ?? "").toString().trim() || `עמודה_${i + 1}`;
    if (seen.has(name)) {
      const count = seen.get(name) + 1;
      seen.set(name, count);
      name = `${name}_${count}`;
    } else {
      seen.set(name, 0);
    }
    return name;
  });
}

// Returns { headers: string[], rows: Record<string,string>[] }.
// Blank rows are skipped. Missing/duplicate headers are auto-named.
export async function parseContactsFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  let workbook;
  if (ext === "csv") {
    const text = await file.text();
    workbook = XLSX.read(text, { type: "string" });
  } else {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(buffer, { type: "array" });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];

  // raw:false formats numbers/dates the way Excel would display them,
  // which keeps plain phone numbers like 501234567 from turning into
  // "501234567.0" or similar.
  const grid = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });

  if (!grid.length) return { headers: [], rows: [] };

  const headers = dedupeHeaders(grid[0]);
  const rows = [];
  for (let i = 1; i < grid.length; i += 1) {
    const rawRow = grid[i];
    if (!rawRow.some((cell) => String(cell ?? "").trim() !== "")) continue;
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = rawRow[idx] !== undefined ? String(rawRow[idx]).trim() : "";
    });
    rows.push(row);
  }

  return { headers, rows };
}

// Best-effort guess of which column holds the phone number.
export function guessPhoneColumn(headers) {
  for (const header of headers) {
    const low = header.toLowerCase();
    if (PHONE_HEADER_HINTS.some((hint) => header.includes(hint) || low.includes(hint))) {
      return header;
    }
  }
  return headers[0] ?? null;
}

const NAME_HEADER_HINTS = [
  "שם מלא", "שם פרטי", "שם", "name", "full name", "first name",
];

// Best-effort guess of which column holds the contact's name (used when
// saving contacts to the phone). Falls back to the first column that isn't
// the phone column, rather than headers[0] blindly, since headers[0] is
// often itself the phone column in simple two-column files.
export function guessNameColumn(headers) {
  for (const header of headers) {
    const low = header.toLowerCase();
    if (NAME_HEADER_HINTS.some((hint) => header.includes(hint) || low.includes(hint))) {
      return header;
    }
  }
  const phoneColumn = guessPhoneColumn(headers);
  return headers.find((h) => h !== phoneColumn) ?? headers[0] ?? null;
}

const COUNTRY_CODE_HEADER_HINTS = [
  "קידומת מדינה", "קידומת", "מדינה", "country code", "country", "dial code",
];

// Best-effort guess of a per-contact country-code column (for WhatsApp) -
// returns null (no guess) rather than falling back to headers[0], since
// most files won't have one at all and guessing wrong here is worse than
// just leaving it unset.
export function guessCountryCodeColumn(headers) {
  for (const header of headers) {
    const low = header.toLowerCase();
    if (COUNTRY_CODE_HEADER_HINTS.some((hint) => header.includes(hint) || low.includes(hint))) {
      return header;
    }
  }
  return null;
}

// Strip spaces/dashes/parentheses etc, keep only digits and a leading +.
export function normalizePhone(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^\d+]/g, "");
}

// Triggers a browser download of a tiny example contacts file, so users
// know exactly what format/columns are expected before making their own.
export function downloadSampleFile() {
  const rows = [
    ["שם", "טלפון", "עיר"],
    ["דוד כהן", "0501234567", "ירושלים"],
    ["שרה לוי", "0521234567", "בני ברק"],
    ["יוסף מזרחי", "0541234567", "אשדוד"],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "אנשי קשר");
  XLSX.writeFile(workbook, "דוגמה-אנשי-קשר.xlsx");
}
