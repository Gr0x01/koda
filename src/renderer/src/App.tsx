import { useEffect, useState } from 'react'
import { OnboardingWizard } from './onboarding/OnboardingWizard'
import { Chassis } from './workspace/Chassis'
import { ProjectHome } from './workspace/ProjectHome'
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

  useEffect(() => {
    window.koda
      .getProjectContext()
      .then(({ projectPath }) => setProjectPath(projectPath))
      .catch(() => setProjectPath('')) // fail safe to ProjectHome rather than a stuck splash
    window.koda
      .getSettings()
      .then((s) => setOnboarded(s.hasOnboarded))
      .catch(() => setOnboarded(true)) // fail safe past onboarding rather than trapping the user
  }, [setProjectPath])

  if (onboarded === null || projectPath === null)
    return <div className="app-drag h-screen w-screen bg-bg" />
  if (!onboarded) return <OnboardingWizard onDone={() => setOnboarded(true)} />
  return (
    <>
      {projectPath === '' ? <ProjectHome /> : <Workspace />}
      {/* App self-update banner + one-time "What's New" popup — every resolved window, never onboarding. */}
      <UpdateSurface />
    </>
  )
}

/** A resolved project: the engine bridge (events, approvals, persistence) + the chassis. Mounted
 *  only once a project is known, so it loads exactly this project's sessions. */
function Workspace() {
  useEngineBridge()
  return <Chassis />
}
