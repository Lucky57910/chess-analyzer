import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import { QueueProvider } from './hooks/useQueue.jsx'
import { SettingsProvider } from './hooks/useSettings.jsx'
import './index.css'

// HashRouter, not BrowserRouter: Capacitor serves the app from a local origin
// with no server to rewrite unknown paths, so a deep link or a reload on
// /stats would 404 against the WebView's own file handler.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <SettingsProvider>
        <QueueProvider>
          <App />
        </QueueProvider>
      </SettingsProvider>
    </HashRouter>
  </StrictMode>,
)
