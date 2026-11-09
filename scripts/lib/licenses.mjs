/**
 * Shared license plumbing for `npm run licenses` and `npm run licenses:check`.
 *
 * Everything is derived from `package-lock.json`, so the notices and the gate
 * describe the dependency tree a clean `npm ci` installs — no package under
 * `node_modules/` has to be present for the check to be meaningful, and a
 * platform-specific optional package that is not installed on this machine is
 * still listed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const POLICY_PATH = 'security/allowed-licenses.json';

export function readPolicy(root = process.cwd()) {
  const policy = JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8'));
  return {
    allow: new Set(policy.allow ?? []),
    choices: policy.choices ?? {},
    overrides: policy.overrides ?? {},
  };
}

/**
 * Every installed-at-runtime package, direct and transitive, sorted by name and
 * version. `dev === true` entries (Vitest, Playwright, Vite…) are not shipped
 * and are out of scope.
 */
export function productionPackages(root = process.cwd()) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '') continue;
    if (entry.dev === true || entry.devOptional === true) continue;
    if (entry.link) continue;
    const name = entry.name ?? key.replace(/^.*node_modules\//, '');
    out.push({
      name,
      version: entry.version ?? 'unknown',
      license: entry.license ?? '(none declared)',
      dir: join(root, key),
      /** A URL dependency has no npm page; its tarball is the source. */
      source: rootManifest.dependencies?.[name]?.startsWith('http') ? rootManifest.dependencies[name] : null,
    });
  }
  return out.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

// ---------------------------------------------------------------- SPDX ------

/** Split an SPDX expression into tokens, keeping parentheses and operators. */
function tokenize(expression) {
  const spaced = expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .replace(/\s+(AND|OR|WITH)\s+/gi, (match) => ` ${match.trim().toUpperCase()} `);
  return spaced.trim().split(/\s+/).filter(Boolean);
}

/**
 * Evaluate an SPDX expression against a predicate, e.g. "is this identifier on
 * the allowlist". Handles `OR`, `AND` and `WITH` (evaluated as its left side;
 * the exception is informational), with parentheses.
 */
export function evaluateExpression(expression, predicate, tokens = tokenize(expression), state = { at: 0 }) {
  const next = () => tokens[state.at++];

  const atom = () => {
    const token = next();
    if (token === '(') {
      const value = or();
      next(); // ')'
      return value;
    }
    if (token === undefined) return false;
    return predicate(token);
  };

  const and = () => {
    let value = atom();
    while (tokens[state.at] === 'AND' || tokens[state.at] === 'WITH') {
      state.at += 1;
      const right = atom();
      value = tokens[state.at - 1] === 'WITH' ? value : value && right;
    }
    return value;
  };

  const or = () => {
    let value = and();
    while (tokens[state.at] === 'OR') {
      state.at += 1;
      const right = and();
      value = value || right;
    }
    return value;
  };

  return or();
}

/** The allowlisted identifier an expression can be satisfied with, or null. */
export function chooseLicense(expression, allow) {
  const identifiers = expression.match(/[A-Za-z0-9.+-]+/g)?.filter((token) => !/^(AND|OR|WITH)$/i.test(token)) ?? [];
  const allowed = identifiers.filter((id) => allow.has(id));
  return allowed.length > 0 ? allowed[0] : null;
}

// --------------------------------------------------------------- texts ------

const CANONICAL_DIR = join('scripts', 'license-texts');

/** Text files that carry a license, best first. */
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|markdown|txt|mdown))?$/i;

function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Packages that are dual licensed ship both texts in one file. When the policy
 * records a choice, the notices reproduce only the chosen license.
 */
function trimToChoice(text, chosen) {
  if (chosen !== 'MIT') return text;
  const mit = text.search(/^The MIT License\s*$/im);
  if (mit < 0) return text;
  const lines = text.slice(mit).split('\n');
  let end = lines.length;
  for (let index = 4; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    // jszip heads its GPL half with "GPL version 3" under a `=====` rule.
    if (/^={5,}$/.test(line) || /^(the\s+)?(gnu\s+)?(gpl|general public license)\b/i.test(line)) {
      end = index;
      break;
    }
  }
  return lines
    .slice(0, end)
    .join('\n')
    .replace(/\n[=-]{3,}\s*$/g, '')
    .trim();
}

export function licenseText(pkg, chosen, root = process.cwd()) {
  const files = licenseFiles(pkg.dir);
  if (files.length > 0) {
    const file = join(pkg.dir, files[0]);
    const raw = readFileSync(file, 'utf8');
    return {
      text: trimToChoice(raw, chosen).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim(),
      from: `${pkg.name}/${files[0]}`,
    };
  }
  const canonical = join(root, CANONICAL_DIR, `${chosen}.txt`);
  if (existsSync(canonical)) {
    return {
      text: readFileSync(canonical, 'utf8').replace(/\r\n/g, '\n').trim(),
      from: `canonical ${chosen} text (the package ships no license file)`,
    };
  }
  return null;
}

export function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Resolve, choose and validate the license of one package. */
export function resolvePackage(pkg, policy) {
  const override = policy.overrides[pkg.name];
  const declared = override?.license ?? pkg.license;
  const choice = policy.choices[pkg.name]?.license;
  const allowedIds = [...policy.allow];

  const onAllowlist = evaluateExpression(declared, (id) => policy.allow.has(id));
  const chosen = choice ?? chooseLicense(declared, policy.allow);
  // "MIT AND Zlib" is an obligation for both, so the whole expression is what
  // has to be recorded — not the first allowlisted term.
  const label = /\bAND\b/i.test(declared) ? declared.replace(/[()]/g, '').replace(/\s+/g, ' ').trim() : chosen;

  return {
    ...pkg,
    declared,
    declaredRaw: pkg.license,
    chosen,
    label,
    allowed: Boolean(onAllowlist && chosen),
    overrideReason: override?.reason ?? null,
    choiceReason: policy.choices[pkg.name]?.reason ?? null,
    allowlist: allowedIds,
  };
}

export const PACKAGE_SOURCE = (name, pkg) => pkg.source ?? `https://www.npmjs.com/package/${name}`;
