import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, getInitialTheme } from './lib/theme'

// Before React mounts, so a stored light-mode preference never flashes dark
// first -- index.css's bare `:root` is dark, and this only touches the DOM
// when the stored theme actually differs from that default.
applyTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
