import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './components/ui/Toast';
import './index.css';
import './i18n/config';

// PWA service worker — production builds only. In dev it would cache Vite's
// transformed modules and fight HMR, and it also requires a secure context
// (HTTPS or localhost), which a LAN IP over plain http is not — so a failed
// registration is expected there and must stay silent. The PWA layer is an
// enhancement: it never gates the app.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* insecure context, browser without SW support, or SW disabled */
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/webui">
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <SettingsProvider>
              <ProjectProvider>
                <WebSocketProvider>
                  <App />
                </WebSocketProvider>
              </ProjectProvider>
            </SettingsProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
