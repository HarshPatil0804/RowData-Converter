#!/usr/bin/env node
/**
 * The licence gate: every production dependency must carry a licence from
 * `security/allowed-licenses.json`.
 *
 *   node scripts/check-licenses.mjs
 *
 * It reads the tree from `package-lock.json`, so it describes what `npm ci`
 * installs. An SPDX expression is accepted when it can be satisfied using only
 * allowlisted identifiers: `(MIT OR GPL-3.0-or-later)` passes on MIT,
 * `(MIT AND Zlib)` needs both. A dual-licensed package's recorded choice is
 * printed; an undeclared or unlisted licence fails the build.
 */
import {
  POLICY_PATH,
  evaluateExpression,
  productionPackages,
  readPolicy,
  resolvePackage,
  chooseLicense,
} from './lib/licenses.mjs';

const policy = readPolicy();
const packages = productionPackages().map((pkg) => resolvePackage(pkg, policy));

const failures = [];
for (const pkg of packages) {
  if (pkg.allowed && pkg.chosen) continue;
  failures.push(
    `${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.declaredRaw)} ` +
      `(not covered by ${POLICY_PATH})`,
  );
}

const counts = new Map();
for (const pkg of packages) counts.set(pkg.label ?? 'UNRESOLVED', (counts.get(pkg.label ?? 'UNRESOLVED') ?? 0) + 1);

console.log(`check-licenses: ${packages.length} production packages`);
console.log(`  allowlist (${POLICY_PATH}): ${[...policy.allow].join(', ')}`);
for (const [license, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)} × ${license}`);
}
for (const [name, choice] of Object.entries(policy.choices)) {
  const pkg = packages.find((entry) => entry.name === name);
  if (!pkg) continue;
  const satisfiable = evaluateExpression(pkg.declaredRaw, (id) => policy.allow.has(id));
  console.log(
    `  choice: ${name} — declared ${JSON.stringify(pkg.declaredRaw)}, used as ${choice.license} ` +
      `(allowlisted option available: ${satisfiable ? 'yes' : 'NO'}, first allowed: ${chooseLicense(
        pkg.declaredRaw,
        policy.allow,
      )})`,
  );
}
for (const [name, override] of Object.entries(policy.overrides)) {
  console.log(`  resolved: ${name} — ${JSON.stringify(override.license)} (${override.reason})`);
}

if (failures.length > 0) {
  console.error(`\ncheck-licenses: FAILED\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}

console.log('check-licenses: OK — every production dependency is on the allowlist');
