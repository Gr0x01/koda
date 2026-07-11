import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { ThemeProvider, initTheme } from './theme'
import { TextSizeProvider, initTextSize } from './text-size'
import App from './App'
import { ErrorBoundary } from './ui'
import { installRendererLogForwarding } from './logging'
import './styles/index.css'

installRendererLogForwarding()
// Apply the saved appearance + reading text size before first paint (no flash).
initTheme()
initTextSize()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost so a crash in any provider or in App lands on the recovery card, never a black
        window. The card's colors come from CSS vars initTheme() sets on the document, so it renders
        correctly even if ThemeProvider is what threw. */}
    <ErrorBoundary>
      {/* reducedMotion="user" → every preset honors the OS "reduce motion" setting globally,
          collapsing transforms to instant cross-fades without per-component checks. */}
      <MotionConfig reducedMotion="user">
        <ThemeProvider>
          <TextSizeProvider>
            <App />
          </TextSizeProvider>
        </ThemeProvider>
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
)
