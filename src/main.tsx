import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { trustedScriptUrl } from './lib/trusted';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support: a service worker precaches the built assets after the first
// visit, so the app (including OCR/PDF assets) works with no network at all.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Trusted Types: `register` takes a TrustedScriptURL under the CSP.
    navigator.serviceWorker.register(trustedScriptUrl('./sw.js')).catch(() => {
      // Offline support is progressive enhancement; the app still works online.
    });
  });
}
