import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { UnitsProvider } from './lib/unitsContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside <App> because every tab reads it, including the Units tab
        itself. It holds display preferences only -- nothing here can reach
        the config the physics runs on. */}
    <UnitsProvider>
      <App />
    </UnitsProvider>
  </StrictMode>,
)
