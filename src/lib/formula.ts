/**
 * Formula-injection detection, shared by the pipeline (which counts the cells)
 * and the export writer (which neutralises them).
 *
 * Kept in its own module so the pipeline does not have to import the export
 * writer, which pulls SheetJS into the bundle.
 *
 * Excel, LibreOffice and Google Sheets all evaluate a cell whose first
 * character is `=`, `+`, `-` or `@`, and also strip a leading TAB or CR before
 * deciding. So `=HYPERLINK("link","y")` opens as a live link and the DDE
 * form `=cmd|' /C calc'!A0` can spawn a process on Windows. A leading
 * apostrophe forces the cell to text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A normalised phone number is "+" followed by digits. A spreadsheet reads that
 * as a formula for a number, so prefixing it with an apostrophe would turn the
 * number into text. It is also not an injection: nothing can follow the +
 * except digits. "+1+1" and every other lead-in still count.
 */
const PHONE_LIKE = /^\+\d{7,15}$/;

export function isFormulaLike(value: string): boolean {
  if (PHONE_LIKE.test(value)) return false;
  return FORMULA_LEAD.test(value);
}

/**
 * Count the cells a spreadsheet-safe export would neutralise: text-typed cells
 * whose first character is a formula lead-in. Numbers and dates are never
 * touched, so a real negative number stays a number.
 *
 * A column with no declared type counts as text — the safer default.
 */
export function countFormulaLike(
  rows: readonly (readonly unknown[])[],
  types: readonly string[],
): number {
  let count = 0;
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const type = types[column];
      if (type !== undefined && type !== 'text') continue;
      const value = row[column];
      if (typeof value === 'string' && isFormulaLike(value)) count += 1;
    }
  }
  return count;
}
