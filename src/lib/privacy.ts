/**
 * Local-data hygiene: leave nothing behind.
 *
 * The charter is "nothing persisted": not a file, not a derived value, and not a
 * preference. So this module has two jobs:
 *
 *   - `purgeBrowserStorage()` runs on every boot and after Clear data. It
 *     unregisters any service worker (including one left by an older build) and
 *     deletes every Cache Storage entry, then empties the other stores.
 *   - `clearStoredData()` is the user-facing version, with no theme exception.
 *
 * Everything is best-effort: a browser in private mode can refuse, and the app
 * must still work.
 */

async function unregisterServiceWorkers(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) await registration.unregister();
  } catch {
    // No service worker support, or refused.
  }
}

async function deleteCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const key of await caches.keys()) await caches.delete(key);
  } catch {
    // Cache API unavailable.
  }
}

export async function purgeBrowserStorage(): Promise<void> {
  await unregisterServiceWorkers();
  await deleteCaches();

  try {
    localStorage.clear();
  } catch {
    // storage disabled
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
}

/** Clear data: identical to the boot purge, and it keeps no UI preference. */
export async function clearStoredData(): Promise<void> {
  await purgeBrowserStorage();
}
