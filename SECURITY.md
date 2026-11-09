# Security policy

## What this project is

A fully client-side converter: the browser parses your files and nothing is
uploaded. The privacy claims are enforced by tests (`tests/privacy.test.ts`,
`tests/offline-browser.test.ts`, `tests/static-hosting.test.ts`,
`scripts/scan-dist.mjs`), so a report that a claim is false is a security
report, not a feature request.

## Reporting a vulnerability privately

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:

<https://github.com/HarshPatil0804/RowData-Converter/security/advisories/new>

That channel is visible only to the maintainer. If it is unavailable to you,
open a normal issue that says only "I have a security report, please contact
me" — with no details, no file, no payload and no reproduction — and wait for a
private channel to be arranged.

Please include, in the private report:

- the affected version (the build hash in the page footer) and the URL;
- what an attacker gains, and what they need to start (a crafted file, a
  browser extension, a compromised dependency, a host change…);
- the smallest synthetic input that reproduces it — **never a real file**, and
  never real personal or confidential data;
- whether the issue also affects the deployed site.

## What to expect

- Acknowledgement within 7 days.
- An assessment (affected / not affected / needs more information) within 30
  days, and a fix or a documented mitigation for anything confirmed.
- Credit in the advisory if you want it, or anonymity if you prefer. No bug
  bounty is offered.

Please give a fix a reasonable amount of time before publishing details.

## Scope

In scope: the code in this repository, the built bundle it produces, the sample
and hostile fixtures, the CI configuration, and the deployed static site.

Out of scope: vulnerabilities that require the user's device or browser to be
compromised already, denial of service by dropping an enormous file (the limits
are documented in the README), reports produced only by an automated scanner
with no impact described, and social engineering.

## Supported versions

The deployed site always runs the latest `main`. Older commits are not
maintained; if you report against an old build hash, please reproduce it on the
current one first.
