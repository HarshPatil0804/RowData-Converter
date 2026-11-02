# Held-out samples

Drop files here to measure correctness on data the rules have never seen.

Rules for this folder:

- Files placed here are **held out**: no rule, threshold, column name or
  expected number in `src/` may be written to make them pass.
- Running `npm run report` processes every file in this folder and prints, per
  file: rows in / clean / rejected, duplicate count, flag counts,
  low-confidence items, which invariants passed or failed, and which pipeline
  rules fired.
- The invariant suite (`npm test`) also discovers these files automatically
  and checks the ten general invariants — never exact numbers.

This folder is empty by design.
