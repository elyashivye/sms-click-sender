// Simple {placeholder} substitution using row data from the uploaded contacts file.

const PLACEHOLDER_RE = /\{([^{}]+)\}/g;

export function findPlaceholders(text) {
  const found = new Set();
  for (const match of (text || "").matchAll(PLACEHOLDER_RE)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

// Replace every {ColumnName} in template with row[ColumnName]. Unknown
// placeholders (typos, missing columns) are left untouched so they're easy
// to spot in the preview instead of silently disappearing.
export function render(template, row) {
  return (template || "").replace(PLACEHOLDER_RE, (whole, key) => {
    const value = row ? row[key] : undefined;
    return value === undefined || value === null ? whole : String(value);
  });
}

export function unknownPlaceholders(template, knownHeaders) {
  const known = new Set(knownHeaders || []);
  return findPlaceholders(template).filter((p) => !known.has(p));
}
