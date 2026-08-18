import { SettingsSection } from './controls'
import { BrowserTestingRow, RuntimeRow } from './ApprovalsSection'

// A fresh Mac has no Node and only a locked-down system Python, so apps and scripts the agent writes
// can't run. Koda can provision either on demand — downloaded into Koda's own folder, no system
// changes. If the user already has the runtime, we say so and offer nothing. See runtime/provision.ts.
export function ToolsSection() {
  return (
    <SettingsSection
      title="Toolkit"
      note="Each of these downloads once into Koda's own folder, is shared by every project, changes nothing else on your Mac, and leaves nothing to uninstall. Node is about 50 MB, Python about 25 MB, a browser about 150 MB."
    >
      <RuntimeRow
        runtime="node"
        label="Node.js runtime"
        description="Set up Node.js so apps that store data or run their own server can work."
      />
      <RuntimeRow
        runtime="python"
        label="Python runtime"
        description="Set up Python for data work, automation, and the AI tools that expect it."
      />
      <BrowserTestingRow />
    </SettingsSection>
  )
}
