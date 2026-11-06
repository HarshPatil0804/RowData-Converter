import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { purgeBrowserStorage } from './lib/privacy';
import './index.css';

// Theme follows the operating system. There is no stored preference to read:
// a toggle lives in this tab's memory only and is gone on reload.
document.documentElement.classList.toggle(
  'dark',
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);

// Nothing persisted means nothing may be cached: unregister any service worker
// (an older build registered one) and delete every Cache Storage entry on boot.
void purgeBrowserStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
