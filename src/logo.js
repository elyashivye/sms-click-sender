// The app's mark: a phone with a message-bubble badge, in the brand's
// primary + success colors. Exported as a template string so both the
// sidebar header and (via a tiny render harness) the generated app icons
// use the exact same source of truth.
export const LOGO_SVG = `
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" rx="13" fill="#4f46e5"/>
  <rect x="13" y="7" width="17" height="30" rx="3.5" stroke="white" stroke-width="2.3" fill="none"/>
  <line x1="18.5" y1="32" x2="24.5" y2="32" stroke="white" stroke-width="2.3" stroke-linecap="round"/>
  <circle cx="35" cy="13" r="10.5" fill="#16a34a"/>
  <rect x="30" y="9" width="10" height="7.5" rx="2.6" fill="white"/>
  <path d="M32.5 16.5 V19.5 L35.5 16.5 Z" fill="white"/>
</svg>
`.trim();
