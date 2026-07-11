// Shared SVG glyphs used across the Versions surface. Extracted to avoid re-declaring the same
// paths in multiple component files. These are display-only; aria-hidden on every one.

export function BranchGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 3-2.5 4.5-6 4.5" />
    </svg>
  )
}

export function UploadGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted" aria-hidden>
      <path d="M12 19V6M6 12l6-6 6 6" />
    </svg>
  )
}
