"""Simple {placeholder} substitution using row data from the uploaded contacts file."""

import re

PLACEHOLDER_RE = re.compile(r"\{([^{}]+)\}")


def find_placeholders(text):
    """Return the sorted, de-duplicated list of {..} placeholder names used in text."""
    return sorted(set(PLACEHOLDER_RE.findall(text or "")))


def render(template, row):
    """Replace every {ColumnName} in template with row[ColumnName].

    Unknown placeholders (typos, missing columns) are left untouched so they
    are easy to spot in the preview instead of silently disappearing.
    """

    def _replace(match):
        key = match.group(1)
        value = row.get(key)
        if value is None:
            return match.group(0)
        return str(value)

    return PLACEHOLDER_RE.sub(_replace, template or "")


def unknown_placeholders(template, known_headers):
    known = set(known_headers or [])
    return [p for p in find_placeholders(template) if p not in known]
