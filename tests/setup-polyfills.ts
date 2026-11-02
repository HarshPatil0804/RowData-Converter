/**
 * Test-environment polyfills.
 *
 * pdf.js v6 calls `Promise.try(...)` unconditionally. That method is ES2025
 * and is missing from the V8 shipped with Node 22 (the version CI runs on),
 * so without this shim the PDF tests reject with
 * `TypeError: Promise.try is not a function` and then hang until the test
 * timeout. Modern browsers and Node ≥ 23 ship it natively; this only fills
 * the gap for older runtimes.
 *
 * See: https://tc39.es/proposal-promise-try/
 */
interface PromiseCtorWithTry extends PromiseConstructor {
  try?: <T>(fn: (...args: never[]) => T, ...args: never[]) => Promise<Awaited<T>>;
}

const P = Promise as PromiseCtorWithTry;

if (typeof P.try !== 'function') {
  P.try = <T>(fn: (...args: never[]) => T, ...args: never[]): Promise<Awaited<T>> =>
    new Promise<Awaited<T>>((resolve) => {
      resolve(fn(...args) as Awaited<T>);
    });
}

export {};