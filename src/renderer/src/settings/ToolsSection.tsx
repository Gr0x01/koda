import { SettingsSection } from './controls'
import { BrowserTestingRow, RuntimeRow } from './ApprovalsSection'

// A fresh Mac has no Node and only a locked-down system Python, so apps and scripts the agent writes
// can't run. Koda can provision either on demand — downloaded into Koda's own folder, no system
// changes. If the user already has the runtime, we say so and offer nothing. See runtime/provision.ts.
export function ToolsSection() {
  return (
    <SettingsSection title="Toolkit">
      <RuntimeRow
        runtime="node"
        label="Node.js runtime"
        description="Apps that store data or run their own server need Node.js. Koda sets it up in its own folder. About 50 MB, no changes to your Mac, nothing to uninstall later."
      />
      <RuntimeRow
        runtime="python"
        label="Python runtime"
        description="Data work, automation, and many AI tools run on Python. Koda sets up a self-contained copy in its own folder. About 25 MB, no changes to your Mac, nothing to uninstall later."
      />
      <BrowserTestingRow />
    </SettingsSection>
  )
}
