import { type ReactNode } from 'react'

// All nav + action icons used within Settings. Inline stroke SVGs (currentColor) — no external dep,
// matches the rail icon set. `Svg` is the shared wrapper; everything else composes from it.

export function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function IconSliders() {
  return (
    <Svg>
      <line x1="4" y1="8" x2="20" y2="8" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="9" cy="8" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="16" r="2.2" fill="currentColor" stroke="none" />
    </Svg>
  )
}
export function IconAppearance() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16" />
      <path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" stroke="none" opacity="0.35" />
    </Svg>
  )
}
export function IconShield() {
  return (
    <Svg>
      <path d="M12 3 5 6v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6l-7-3Z" />
    </Svg>
  )
}
export function IconToolbox() {
  return (
    <Svg>
      <rect x="3" y="8" width="18" height="11" rx="1.5" />
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
      <path d="M10 13v2h4v-2" />
    </Svg>
  )
}
export function IconRemote() {
  return (
    <Svg>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </Svg>
  )
}
export function IconBlocks() {
  return (
    <Svg>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  )
}
export function IconCode() {
  return (
    <Svg>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </Svg>
  )
}
export function IconRewind() {
  return (
    <Svg>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </Svg>
  )
}
export function IconInfo() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  )
}
export function IconChat() {
  return (
    <Svg>
      <path d="M20 11.5a7.5 7.5 0 0 1-10.7 6.8L4 20l1.7-5.3A7.5 7.5 0 1 1 20 11.5Z" />
    </Svg>
  )
}
export function IconArchive() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Svg>
  )
}
export function IconTrash() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  )
}
export function IconUser() {
  return (
    <Svg>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </Svg>
  )
}
export function IconChip() {
  return (
    <Svg>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </Svg>
  )
}
// lucide triangle-alert — the shared warning glyph (memory grown heavy, …).
export function IconWarning() {
  return (
    <Svg>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  )
}
export function IconMemory() {
  return (
    <Svg>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8" />
    </Svg>
  )
}
export function IconBook() {
  return (
    <Svg>
      <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z" />
      <path d="M5 16h13" />
    </Svg>
  )
}
export function IconPlug() {
  return (
    <Svg>
      <path d="M9 3v5M15 3v5" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0V8Z" />
      <path d="M12 16v5" />
    </Svg>
  )
}
