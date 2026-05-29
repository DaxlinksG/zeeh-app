import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@zeehdev/zeeh-kyc-react-sdk/style.css'
import App from './App.tsx'
import { initTheme } from './lib/theme.ts'

// Apply stored theme preference before React renders — prevents flash of wrong theme
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
