/**
 * Local-data hygiene.
 *
 * The app never uploads a file, so the only place data can survive a session is
 * this browser: storage and caches. This removes all of it. The theme
 * preference is deliberately kept, since it is a UI setting, not user data.
 */
export async function clearStoredData(): Promise<void> {
  try {
    localStorage.removeItem('u2s-theme');
    localStorage.clear();
    localStorage.setItem('u2s-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  } catch {
    // storage disabled (private mode) – nothing to clear
  }

  try {
    sessionStorage.clear();
  } catch {
    // storage disabled
  }

  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      for (const db of await indexedDB.databases()) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    }
  } catch {
    // IndexedDB unavailable
  }

  try {
    if (typeof caches !== 'undefined') {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch {
    // Cache API unavailable
  }
}
