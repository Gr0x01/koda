import { useEffect, useState } from 'react'
import { OnboardingWizard } from './onboarding/OnboardingWizard'
import { Chassis } from './workspace/Chassis'
import { ProjectHome } from './workspace/ProjectHome'
import { StageLinkProvider } from './workspace/StageLinks'
import { UpdateSurface } from './workspace/UpdateSurface'
import { useEngineBridge } from './workspace/useEngineBridge'
import { useWorkspace } from './workspace/store'

/**
 * One project per window (ui-workspace.md §9). On boot this window asks main which project it is:
 *   null  → still resolving (brief splash)
 *   ''    → a ProjectHome window — show the folder picker
 *   path  → this project's workspace (mount the engine bridge, which loads its sessions)
 *
 * The first-run onboarding wizard (architecture/onboarding.md) gates everything: until `hasOnboarded`
 * is true it takes over the window, then hands back to the project flow below.
 */
export default function App() {
  const projectPath = useWorkspace((s) => s.projectPath)
  const setProjectPath = useWorkspace((s) => s.setProjectPath)
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  // A ProjectHome window opened by "New Project…" lands with the create modal already open.
  const [newProjectIntent, setNewProjectIntent] = useState(false)

  useEffect(() => {
    window.koda
      .getProjectContext()
      .then(({ projectPath, newProjectIntent }) => {
        setProjectPath(projectPath)
        // Latch: StrictMode double-invokes this effect in dev, and main clears the intent on first
        // read — so the second call returns false. OR it in so the modal still opens.
        setNewProjectIntent((prev) => prev || newProjectIntent)
      })
      .catch(() => setProjectPath('')) // fail safe to ProjectHome rather than a stuck splash
    window.koda
      .getSettings()
      .then((s) => setOnboarded(s.hasOnboarded))
      .catch(() => setOnboarded(true)) // fail safe past onboarding rather than trapping the user
  }, [setProjectPath])

  // Settings are app-global and broadcast to every window on write. A second window opened mid-onboarding
  // reads hasOnboarded:false on boot; without this it would stay trapped in the wizard after another window
  // finishes. Mirror the flag so onboarding state stays in sync across windows.
  useEffect(() => window.koda.onSettingsChanged((s) => setOnboarded(s.hasOnboarded)), [])

  if (onboarded === null || projectPath === null)
    return <div className="app-drag h-screen w-screen bg-bg" />
  if (!onboarded) return <OnboardingWizard onDone={() => setOnboarded(true)} />
  return (
    <>
      {projectPath === '' ? <ProjectHome openCreate={newProjectIntent} /> : <Workspace />}
      {/* App self-update banner + one-time "What's New" popup — every resolved window, never onboarding. */}
      <UpdateSurface />
    </>
  )
}

/** A resolved project: the engine bridge (events, approvals, persistence) + the chassis. Mounted
 *  only once a project is known, so it loads exactly this project's sessions. */
function Workspace() {
  useEngineBridge()
  return (
    <StageLinkProvider>
      <Chassis />
    </StageLinkProvider>
  )
}
