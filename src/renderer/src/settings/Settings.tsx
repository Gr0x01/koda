import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import { useWorkspace } from '../workspace/store'
import { PanelHeader } from '../workspace/PanelHeader'
import { ResizeHandle } from '../workspace/ResizeHandle'
import { RecoverySection } from './RecoverySection'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { ApprovalsSection } from './ApprovalsSection'
import { ToolsSection } from './ToolsSection'
import { ArchivedSection } from './ArchivedSection'
import { BackupSection } from './BackupSection'
import { AboutSection, DeveloperSection } from './AboutSection'
import { ProvidersSection } from './ProvidersSection'
import { GuardrailsSection, SkillsSection } from './GuardrailsSection'
import { MemorySection } from './MemorySection'
import { KodaAccountSection, RemoteSection } from './RemoteSection'
import { FeedbackSection } from './FeedbackSection'
import { windowHasOpenModal } from '../window-modal'
import {
  IconSliders,
  IconAppearance,
  IconUser,
  IconChip,
  IconShield,
  IconBook,
  IconMemory,
  IconWarning,
  IconBlocks,
  IconToolbox,
  IconRemote,
  IconPlug,
  IconRewind,
  IconArchive,
  IconCloudLock,
  IconInfo,
  IconCode,
  IconChat,
} from './icons'

/**
 * The Settings pane (a dedicated rail view, summoned by the rail gear / ⌘,). Two columns: a category
 * nav and a scrollable content area, in Koda's floating language. Curated, not a knob farm — only
 * settings that genuinely earn a control ship. Two distinct account systems live here, kept apart on
 * purpose: "Koda account" (your identity with Koda + its cloud plans) and "AI providers" (the LLM
 * engine billing — Claude now, OpenAI soon). Features still to come show as disabled "Soon" rows.
 */

type CategoryId =
  | 'general'
  | 'koda-account'
  | 'providers'
  | 'appearance'
  | 'approvals'
  | 'guardrails'
  | 'skills'
  | 'memory'
  | 'tools'
  | 'remote'
  | 'archived'
  | 'recovery'
  | 'backup'
  | 'about'
  | 'feedback'
  | 'developer'

// Nav is grouped so the order reads intentionally (macOS System Settings model) rather than as one
// long flat list — related panes sit together under a quiet header. A `soon` entry is a disabled
// placeholder so the product's shape reads at a glance.
type NavItemDef =
  | { id: CategoryId; label: string; icon: ReactNode }
  | { id?: undefined; label: string; icon: ReactNode; soon: true }

const NAV_GROUPS: { title: string; items: NavItemDef[] }[] = [
  {
    title: 'General',
    items: [
      { id: 'general', label: 'General', icon: <IconSliders /> },
      { id: 'appearance', label: 'Appearance', icon: <IconAppearance /> },
    ],
  },
  {
    title: 'Account',
    items: [
      { id: 'koda-account', label: 'Koda account', icon: <IconUser /> },
      { id: 'providers', label: 'AI providers', icon: <IconChip /> },
    ],
  },
  {
    title: 'Agent',
    items: [
      { id: 'approvals', label: 'Agent & Approvals', icon: <IconShield /> },
      { id: 'guardrails', label: 'Guardrails', icon: <IconBook /> },
      { id: 'skills', label: 'Playbook library', icon: <IconBlocks /> },
      { id: 'memory', label: 'Memory', icon: <IconMemory /> },
      { id: 'tools', label: 'Toolkit', icon: <IconToolbox /> },
    ],
  },
  {
    title: 'Connectivity',
    items: [
      { id: 'remote', label: 'Remote', icon: <IconRemote /> },
      { label: 'Integrations', icon: <IconPlug />, soon: true },
    ],
  },
  {
    title: 'History & recovery',
    items: [
      { id: 'recovery', label: 'Recovery', icon: <IconRewind /> },
      { id: 'backup', label: 'Backup', icon: <IconCloudLock /> },
      { id: 'archived', label: 'Archived sessions', icon: <IconArchive /> },
    ],
  },
  {
    title: 'About',
    items: [
      { id: 'feedback', label: 'Send feedback', icon: <IconChat /> },
      { id: 'about', label: 'About', icon: <IconInfo /> },
      // DEV-only: retest onboarding without hand-editing koda-settings.json. Stripped from packaged builds.
      ...(import.meta.env.DEV
        ? [{ id: 'developer' as const, label: 'Developer', icon: <IconCode /> }]
        : []),
    ],
  },
]

// Flat list of the real (navigable) categories — powers the deep-link lookup + default selection.
const CATEGORIES = NAV_GROUPS.flatMap((g) => g.items).filter(
  (i): i is { id: CategoryId; label: string; icon: ReactNode } => 'id' in i && i.id !== undefined,
)

export function Settings() {
  const pendingSection = useWorkspace((s) => s.settingsSection)
  const clearSettingsSection = useWorkspace((s) => s.clearSettingsSection)
  const [active, setActive] = useState<CategoryId>(
    (CATEGORIES.some((c) => c.id === pendingSection) ? pendingSection : 'general') as CategoryId,
  )
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  // Attention dot on the Memory row when this project's navigation notes have grown heavy —
  // the same signal the status-bar pill rides, so the cue survives once Settings is open.
  const memoryHeavy = useWorkspace((s) => s.memoryWeight?.heavy ?? false)

  // Backup is dogfood-flagged: with the flag off the nav row doesn't exist at all — a visible
  // section that only says "not switched on" is for nobody (RB, 07-13).
  const [backupOn, setBackupOn] = useState(false)
  useEffect(() => {
    window.koda
      .getBackupStatus()
      .then((s) => setBackupOn(s.enabled))
      .catch(() => {})
  }, [])
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== 'backup' || backupOn),
  }))

  // Honor a deep link set while Settings was already mounted (e.g. the Remote menu's "Open settings").
  useEffect(() => {
    if (pendingSection && CATEGORIES.some((c) => c.id === pendingSection)) {
      setActive(pendingSection as CategoryId)
      clearSettingsSection()
    }
  }, [pendingSection, clearSettingsSection])

  // The category nav shares the workspace's one panel width (resizable, persisted) so Settings, the
  // Sessions sidebar, and Source Control all stay the same width.
  const width = useWorkspace((s) => s.sidebarWidth)
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const navRef = useRef<HTMLDivElement>(null)

  // Esc closes the pane (matches the recovery drawer / macOS dialog feel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (windowHasOpenModal()) return
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  return (
    <div className="flex h-full min-h-0 bg-bg">
      {/* Category nav */}
      <div
        ref={navRef}
        style={{ width, minWidth: SIDEBAR_MIN_WIDTH }}
        className="relative flex shrink-0 flex-col border-r border-border"
      >
        <PanelHeader
          title={
            <button
              onClick={() => setSettingsOpen(false)}
              title="Back to your project"
              aria-label="Back to your project"
              className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m15 18-6-6 6-6" />
              </svg>
              <span className="font-display text-[11px] font-semibold uppercase tracking-wider">Settings</span>
            </button>
          }
        />
        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1">
          {navGroups.map((group) => (
            <div key={group.title} className="mb-1.5 last:mb-0">
              <div className="px-2.5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-text-muted/55">
                {group.title}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((c) =>
                  'soon' in c ? (
                    <NavItem key={c.label} icon={c.icon} label={c.label} disabled badge="Soon" />
                  ) : (
                    <NavItem
                      key={c.id}
                      icon={c.icon}
                      label={c.label}
                      active={active === c.id}
                      warn={c.id === 'memory' && memoryHeavy}
                      onClick={() => setActive(c.id)}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </nav>

        {/* Drag the nav ⇆ content split (over the right border). */}
        <ResizeHandle
          orientation="vertical"
          onResize={(x) => {
            const left = navRef.current?.getBoundingClientRect().left ?? 0
            setWidth(x - left)
          }}
          onResizeEnd={persistLayout}
        />
      </div>

      {/* Content. Recovery needs the full width (timeline + changes + diff), so it owns the whole
          area + its own scrolling; the knob-style categories sit in the centered reading column. */}
      {active === 'recovery' ? (
        <div className="min-h-0 flex-1">
          <RecoverySection />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* space-y-10 is the section boundary: with rows unboxed, the gap between groups is what
              tells them apart, so it has to be clearly bigger than the gap between rows. */}
          <div className="mx-auto max-w-2xl space-y-10 px-8 py-9">
            {active === 'general' && <GeneralSection />}
            {active === 'koda-account' && <KodaAccountSection />}
            {active === 'providers' && <ProvidersSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'approvals' && <ApprovalsSection />}
            {active === 'guardrails' && <GuardrailsSection />}
            {active === 'skills' && <SkillsSection />}
            {active === 'memory' && <MemorySection />}
            {active === 'tools' && <ToolsSection />}
            {active === 'remote' && <RemoteSection />}
            {active === 'archived' && <ArchivedSection />}
            {active === 'backup' && <BackupSection />}
            {active === 'about' && <AboutSection />}
            {active === 'feedback' && <FeedbackSection />}
            {active === 'developer' && <DeveloperSection />}
          </div>
        </div>
      )}
    </div>
  )
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  badge,
  warn = false,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  badge?: string
  /** An amber warning glyph (e.g. Memory has grown heavy) — a quiet "look here" that rides the row. */
  warn?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors disabled:cursor-default ${
        active
          ? 'bg-surface font-medium text-text'
          : disabled
            ? 'text-text-muted/45'
            : 'text-text hover:bg-surface'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {warn && (
        <span className="shrink-0 text-amber-500 [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
          <IconWarning />
        </span>
      )}
      {badge && (
        <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-text-muted/70">
          {badge}
        </span>
      )}
    </button>
  )
}
