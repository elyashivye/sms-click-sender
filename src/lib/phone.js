// WhatsApp's click-to-chat link (wa.me) needs the number in full
// international format with no "+", no leading 0, no spaces/dashes -
// unlike plain SMS, which accepts local-format numbers just fine.

import { normalizePhone } from "./excel.js";

// value: whatever came from the contacts file (already SMS-normalized or
// raw). countryCode: digits only, e.g. "972" for Israel.
export function toWhatsAppNumber(value, countryCode) {
  const digits = normalizePhone(value).replace(/^\+/, "");
  if (!digits) return "";

  // Local format (e.g. Israeli mobile "0501234567") - swap the leading 0
  // for the country code. Anything else is assumed to already be in
  // international format (e.g. "972501234567") and is left as-is.
  if (digits.startsWith("0")) {
    return `${countryCode}${digits.slice(1)}`;
  }
  return digits;
}
