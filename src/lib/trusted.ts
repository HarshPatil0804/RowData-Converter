/**
 * Trusted Types support for the two places this app hands the browser a script
 * URL: the pipeline Worker and the service-worker registration.
 *
 * The CSP in `vercel.json` sends `require-trusted-types-for 'script'` with a
 * single named policy. Under that policy a plain string is refused by the
 * browser ("This document requires 'TrustedScriptURL' assignment"), so both
 * call sites go through here. The policy is deliberately narrow: it only mints
 * a script URL that is same-origin and ends in `.js`/`.mjs`, so it cannot be
 * used to point the app at somebody else's script even if a future bug fed it
 * attacker-controlled input.
 *
 * Browsers without Trusted Types (Firefox, Safari) take the plain string: the
 * directive is Chromium-only and has no meaning there, so nothing is lost.
 */
interface ScriptUrlPolicy {
  createScriptURL(value: string): unknown;
}

interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL(value: string): string },
  ): ScriptUrlPolicy;
}

let cached: ScriptUrlPolicy | null | undefined;

function factory(): TrustedTypesFactory | null {
  const candidate = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  return candidate ?? null;
}

function policy(): ScriptUrlPolicy | null {
  if (cached !== undefined) return cached;
  const host = factory();
  if (!host) {
    cached = null;
    return null;
  }
  cached = host.createPolicy('u2s-worker', {
    createScriptURL(value: string) {
      // Same-origin only, and only a script. A relative URL resolves against
      // the document, which is what `register('./sw.js')` relies on.
      const resolved = new URL(value, typeof location === 'undefined' ? undefined : location.href);
      if (resolved.origin !== location.origin) throw new TypeError(`refusing cross-origin script URL: ${value}`);
      if (!/\.m?js$/.test(resolved.pathname)) throw new TypeError(`refusing non-script URL: ${value}`);
      return value;
    },
  });
  return cached;
}

/** A script URL the browser will accept under `require-trusted-types-for`. */
export function trustedScriptUrl(value: string | URL): string {
  const text = typeof value === 'string' ? value : value.href;
  const minted = policy();
  // `createScriptURL` returns a TrustedScriptURL object; `Worker` and
  // `register` accept it, and the cast keeps the DOM typings happy.
  return minted ? (minted.createScriptURL(text) as string) : text;
}

