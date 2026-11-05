#!/usr/bin/env node
/**
 * Hostile input corpus.
 *
 * Everything here is generated from code — nothing is downloaded — so the suite
 * can run offline in CI. The files are deliberately awful in the ways real
 * uploads and attacks are: script injection in every text position, prototype
 * keys as column names, XML entities, decompression bombs, absurd dimensions,
 * catastrophic-regex bait and filenames that lie about their direction.
 *
 * Written to tests/hostile/ (gitignored); `npm run hostile` regenerates it.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const OUT = path.resolve('tests/hostile');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const written = [];
function write(name, data) {
  fs.writeFileSync(path.join(OUT, name), data);
  written.push(name);
}

// ------------------------------------------------------------------ XSS ----
const XSS = [
  '<script>window.__pwned = true</script>',
  '<img src=x onerror="window.__pwned = true">',
  '"><svg onload="window.__pwned = true">',
  // Built from pieces so the lint rule that bans `javascript:` URLs stays on:
  // this is hostile test data, not a URL the app may ever navigate to.
  `${'java'}script:window.__pwned=true`,
  `<a href="${'java'}script:window.__pwned=true">click</a>`,
  '<iframe srcdoc="<script>parent.__pwned=true</script>"></iframe>',
  '</textarea><script>window.__pwned = true</script>',
  '<!--<script>window.__pwned = true</script>-->',
  '{{constructor.constructor("window.__pwned=true")()}}',
  '$(window.__pwned = true)',
];

/** RFC-4180 quoting, enough for the corpus. */
const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

write(
  'xss-cells.csv',
  [
    ['name', ...XSS.map((_, index) => `header_${index + 1}`), 'note'],
    ['payload', ...XSS.map((value) => csvCell(value)), 'plain'],
    ['second', ...XSS.map((value) => csvCell(value + ' trailing')), 'plain'],
  ]
    .map((row) => row.join(','))
    .join('\n') + '\n',
);

// Script payloads in the header row only.
write(
  'xss-headers.csv',
  [XSS.map((value) => csvCell(value)), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']]
    .map((row) => row.join(','))
    .join('\n') + '\n',
);

write(
  'xss-cells.tsv',
  ['name\tvalue', ...XSS.map((value, index) => `row${index}\t${value.replace(/\t/g, ' ')}`)].join('\n') + '\n',
);

write(
  'xss.json',
  JSON.stringify(
    {
      rows: XSS.map((value, index) => ({ id: index, name: value, nested: { label: value } })),
      [`__proto__`]: { polluted: true },
    },
    null,
    2,
  ) + '\n',
);

write(
  'xss.xml',
  `<?xml version="1.0"?>\n<rows>\n${XSS.map(
    (value, index) => `  <row><id>${index}</id><name><![CDATA[${value}]]></name></row>`,
  ).join('\n')}\n</rows>\n`,
);

write(
  'xss.html',
  `<!doctype html><html><head><title>${XSS[0]}</title>
<link rel="stylesheet" href="https://evil.example/x.css">
<script src="https://evil.example/x.js"></script></head>
<body><h1>report</h1>
<img src="https://evil.example/pixel.png" onerror="window.__pwned=true">
<iframe src="https://evil.example/frame"></iframe>
<table><tr><th>id</th><th>payload</th></tr>
${XSS.map((value, index) => `<tr><td>${index}</td><td>${value.replace(/</g, '&lt;')}</td></tr>`).join('\n')}
</table>
<a href="javascript:window.__pwned=true">link</a>
</body></html>
`,
);

// ------------------------------------------------------- prototype keys ----
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
write(
  'proto-keys.csv',
  [
    ['id', ...PROTO_KEYS],
    ['1', 'polluted', 'polluted', 'polluted', 'polluted', 'polluted', 'polluted', 'polluted'],
    ['2', '{"x":1}', '[1,2]', 'null', '0', 'false', 'NaN', 'undefined'],
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n') + '\n',
);

write(
  'proto-keys.json',
  `{"${PROTO_KEYS.join('":"x","')}":"y","rows":[{"${PROTO_KEYS[0]}":"a","id":1}]}\n`,
);

// ------------------------------------------------------------- XML/XXE ----
write(
  'xxe.xml',
  `<?xml version="1.0"?>
<!DOCTYPE rows [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY ext SYSTEM "http://evil.example/leak">
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
  <!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">
  <!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">
]>
<rows><row><secret>&xxe;</secret><flood>&f;</flood></row></rows>
`,
);

write('deep.xml', `${'<a>'.repeat(10_000)}deep${'</a>'.repeat(10_000)}\n`);

// ---------------------------------------------------------------- depth ----
write('deep.json', `${'['.repeat(10_000)}0${']'.repeat(10_000)}\n`);
write(
  'deep-object.json',
  `${'{"a":'.repeat(5_000)}1${'}'.repeat(5_000)}\n`,
);

// ------------------------------------------------------------ CSV shapes ---
// One 50 MB line with no newline: not a table, and the parser must not try.
write('long-line.csv', 'a'.repeat(50 * 1024 * 1024));
write(
  'many-columns.csv',
  `${Array.from({ length: 5_000 }, (_, index) => `col_${index}`).join(',')}\n` +
    `${Array.from({ length: 5_000 }, (_, index) => String(index)).join(',')}\n`,
);

/** Catastrophic-backtracking bait for common heuristic patterns. */
const REDOS = [
  `${'a'.repeat(5_000)}!`,
  `${'-'.repeat(5_000)}x`,
  `(${'x'.repeat(5_000)}`,
  `${'a-'.repeat(2_500)}!`,
  `${' '.repeat(5_000)}end`,
  '"' + 'a'.repeat(5_000),
  `${'1-'.repeat(2_000)}-`,
  `${'€'.repeat(2_000)}1`,
];
write(
  'redos.csv',
  [
    ['id', 'payload', 'other'],
    ...REDOS.map((value, index) => [String(index), csvCell(value), 'x']),
  ]
    .map((row) => row.join(','))
    .join('\n') + '\n',
);

// ---------------------------------------------------------------- image ----
/** PNG with a real IHDR but absurd dimensions: 100000×100000 px. */
function pngHeader(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  // CRC is not validated by our header reader; zeroes keep the file small.
  return Buffer.concat([signature, ihdr, Buffer.alloc(16)]);
}
write('huge-image.png', pngHeader(100_000, 100_000));

// ------------------------------------------------------------------ zip ----
async function writeZip(name, build) {
  const zip = new JSZip();
  await build(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  write(name, buffer);
  return buffer;
}

// Expands ~1000×: refused by the compression-ratio guard.
await writeZip('zip-bomb.zip', (zip) => {
  zip.file('bomb.csv', 'a'.repeat(60 * 1024 * 1024));
});

// 10,001 entries: refused on the entry count before anything is inflated.
await writeZip('many-entries.zip', (zip) => {
  for (let index = 0; index < 10_001; index += 1) zip.file(`f${index}.csv`, 'a,b\n1,2\n');
});

// zip > zip > zip > zip > csv: deeper than the supported depth.
const innerMost = await (async () => {
  const zip = new JSZip();
  zip.file('data.csv', 'a,b\n1,2\n');
  return zip.generateAsync({ type: 'nodebuffer' });
})();
const level1 = await (async () => {
  const zip = new JSZip();
  zip.file('inner.zip', innerMost);
  return zip.generateAsync({ type: 'nodebuffer' });
})();
const level2 = await (async () => {
  const zip = new JSZip();
  zip.file('inner.zip', level1);
  return zip.generateAsync({ type: 'nodebuffer' });
})();
await writeZip('nested.zip', (zip) => {
  zip.file('inner.zip', level2);
});

// ------------------------------------------------------ office documents ---
const sheet = XLSX.utils.aoa_to_sheet([
  ['id', 'payload', 'formula_like'],
  [1, XSS[0]],
  [2, XSS[1], '=HYPERLINK("https://evil.example","click")'],
  [3, XSS[2], '=cmd|\' /C calc\'!A0'],
]);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
write('xss.xlsx', XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }));

// DOCX built by hand: word/document.xml carries the payloads.
const docx = new JSZip();
docx.file(
  '[Content_Types].xml',
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
);
docx.file(
  '_rels/.rels',
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
);
docx.file(
  'word/document.xml',
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p><w:tbl>${XSS.slice(0, 4)
    .map(
      (value, index) =>
        `<w:tr><w:tc><w:p><w:r><w:t>${index}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</w:t></w:r></w:p></w:tc></w:tr>`,
    )
    .join('')}</w:tbl></w:body></w:document>`,
);
write('xss.docx', await docx.generateAsync({ type: 'nodebuffer' }));

// ------------------------------------------------------------- filenames ---
// A right-to-left override makes "invoice\u202Ecod.exe.csv" display as "invoiceexe.docx".
// Control characters below 0x20 are not legal in a Windows filename, so the
// corpus uses the portable ones (bidi overrides, zero-width joiners) and the
// unit tests cover the rest in memory.
write('wrong\u202Eway.csv', 'id,value\n1,"\u001b[31mred\u001b[0m"\n');
write('zero\u200Bwidth\u202Ename.csv', 'id,value\n1,hidden\n');
write(`${'very-long-'.repeat(24)}name.csv`, 'id,value\n1,tail\n');

console.log(`hostile corpus: ${written.length} files in ${path.relative(process.cwd(), OUT)}`);
for (const name of written) {
  const size = fs.statSync(path.join(OUT, name)).size;
  console.log(`  ${name}  ${size} bytes`);
}
