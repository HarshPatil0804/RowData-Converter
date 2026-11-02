/**
 * Generates the messy sample corpus in /samples. Run: npm run samples
 * Append --large to also write a 50 MB stress CSV (samples/.large/, gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import XLSX from 'xlsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samples = path.join(root, 'samples', 'dev');
fs.mkdirSync(samples, { recursive: true });
fs.mkdirSync(path.join(samples, '.large'), { recursive: true });

const written = [];
const write = (name, content) => {
  fs.writeFileSync(path.join(samples, name), content);
  written.push(name);
};

// --------------------------------------------------------------- messy CSV --
const messyRows = [
  'Date,Product,Units,Unit Price,Region,Notes,',
  '2024-01-05,Widget,10,19.99,North, ,',
  '01/06/2024, Gadget ,7,$149.00,North,first order,',
  '2024-01-05,Widget,10,19.99,North, ,',
  'N/A,Doohickey,130,4.25,East,low margin,',
  'N/A,-,N/A,-,N/A,-,',
  '2024-01-12,Blob,5,25.00,West,-,',
  '2024-01-13,Sprocket,4,$8.75,East,priority,',
  '2024-01-14,Gadget,7,149.00,North,,',
  '01/15/2024,Widget,6,19.99,North,reorder,',
  '2024-01-16,Doohickey,9,4.25,North,,',
  '2024-01-17,Blob,3,25.00,West,,',
  '2024-01-18,Sprocket,11,8.75,East,,',
  ',Gadget,2,149.00,North,,',
  '2024-01-20,Widget,5,19.99,,clearance,',
];
write('messy_sales.csv', `${messyRows.join('\n')}\n`);

// --------------------------------------------------------------------- TSV --
write(
  'orders.tsv',
  [
    'order_id\tcustomer\tamount\tshipped',
    '1001\tAlice\t250.50\tyes',
    '1002\tBob\t99.00\tno',
    '1003\tCarol\t1,204.75\tyes',
    '1004\tAlice\t75.25\tno',
    '1005\tDave\t640.00\tyes',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------- headerless
write(
  'headerless_data.csv',
  [
    'Widget,42,2024-01-05,19.99',
    'Gadget,7,2024-01-08,149.00',
    'Doohickey,130,2024-02-11,4.25',
    'Sprocket,3,2024-02-14,8.75',
    '',
  ].join('\n'),
);

// ----------------------------------------------------------- nested JSON ----
const customers = [
  {
    id: 1,
    name: 'Alice Smith',
    contact: { email: 'alice@northwind.test', phone: '+1 415 555 0101' },
    orders: [
      { sku: 'A-1', qty: 3, price: 19.99 },
      { sku: 'A-2', qty: 1, price: 5.5 },
    ],
    active: true,
    tags: ['vip', 'beta'],
  },
  {
    id: 2,
    name: 'Bob Jones',
    contact: { email: 'bob@contoso.test', phone: '+1 212 555 0198' },
    orders: [{ sku: 'B-7', qty: 8, price: 12.25 }],
    active: false,
    tags: ['churn-risk'],
  },
  {
    id: 3,
    name: 'Carol Rivera',
    contact: { email: 'carol@globex.test', phone: '+44 20 7946 0958' },
    orders: [
      { sku: 'C-3', qty: 5, price: 42.0 },
      { sku: 'C-4', qty: 2, price: 9.75 },
    ],
    active: true,
    tags: [],
  },
  {
    id: 4,
    name: 'Dan Okafor',
    contact: { email: 'dan@initech.test', phone: '+49 30 901820' },
    orders: [{ sku: 'D-1', qty: 12, price: 4.5 }],
    active: true,
    tags: ['new'],
  },
];
write(
  'nested_customers.json',
  `${JSON.stringify({ generated: '2024-06-01', currency: 'USD', customers }, null, 2)}\n`,
);

// ------------------------------------------------------------------ NDJSON ---
write(
  'events.ndjson',
  [
    '{"ts":"2024-03-01T10:00:00Z","event":"login","user":"alice","duration":12.4}',
    '{"ts":"2024-03-01T10:00:05Z","event":"view","user":"alice","duration":3.1}',
    '{"ts":"2024-03-01T10:00:09Z","event":"purchase","user":"bob","duration":44.2,"amount":99.9}',
    'THIS LINE IS CORRUPT {{{',
    '{"ts":"2024-03-01T10:01:00Z","event":"logout","user":"bob","duration":1.2}',
    '{"ts":"2024-03-01T10:01:30Z","event":"login","user":"carol","duration":8.8}',
    '',
  ].join('\n'),
);

// -------------------------------------------------------------------- XML ----
const book = (id, title, author, price, year, available) =>
  `  <book id="${id}" available="${available}">\n    <title>${title}</title>\n    <author>${author}</author>\n    <price currency="USD">${price}</price>\n    <year>${year}</year>\n  </book>`;
write(
  'catalog.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<catalog>\n  <generated>2024-06-01</generated>\n${[
    book('B-101', 'Zero to One', 'Blake Masters', '18.50', '2014', 'yes'),
    book('B-102', 'The Pragmatic Programmer', 'Andrew Hunt', '42.00', '1999', 'yes'),
    book('B-103', 'Refactoring', 'Martin Fowler', '54.99', '2018', 'no'),
    book('B-104', 'Clean Code', 'Robert Martin', '39.99', '2008', 'yes'),
  ].join('\n')}\n</catalog>\n`,
);

// -------------------------------------------------------------------- YAML ---
write(
  'config.yaml',
  [
    'app:',
    '  name: order-service',
    '  version: 3.4.1',
    'servers:',
    '  - host: api1.example.com',
    '    port: 8443',
    '    primary: true',
    '  - host: api2.example.com',
    '    port: 9443',
    '    primary: false',
    'logging:',
    '  level: info',
    '  json: true',
    '',
  ].join('\n'),
);

// ------------------------------------------------------------------- HTML ---
write(
  'report.html',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Q3 Headcount</title>
    <style>body { font-family: sans-serif } td { padding: 4px }</style>
  </head>
  <body>
    <h1>Q3 Headcount</h1>
    <table>
      <thead>
        <tr><th>Team</th><th>Headcount</th><th>Budget</th></tr>
      </thead>
      <tbody>
        <tr><td>Engineering</td><td>42</td><td>$1,200,000</td></tr>
        <tr><td>Sales</td><td>18</td><td>$640,000</td></tr>
        <tr><td>Support</td><td>9</td><td>$310,000</td></tr>
        <tr><td>Marketing</td><td>11</td><td>$410,000</td></tr>
      </tbody>
    </table>
    <p>Figures are unaudited.</p>
  </body>
</html>
`,
);

// ---------------------------------------------------------------- Markdown ---
write(
  'readme.md',
  [
    '# Regional sales',
    '',
    'All figures in thousands of USD.',
    '',
    '| Region | Q1   | Q2   | Q3   |',
    '|--------|------|------|------|',
    '| North  | 1200 | 1450 | 1610 |',
    '| South  | 980  | 1025 | 1180 |',
    '| East   | 1440 | 1390 | 1520 |',
    '| West   | 1105 | 1260 | 1330 |',
    '',
    'Notes: Q3 includes one-off licensing revenue in the East region.',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------- free text --
write(
  'plain.txt',
  [
    'Quarterly customer follow-ups',
    '',
    'Alice Johnson is our main contact at Acme Corp. You can reach her at alice.johnson@acme.com or +1 415 555 0132. Her account reference is AC-44719 and the renewal amount is $12,400.00 due 2024-03-15.',
    '',
    'Bob Reyes <bob.reyes@globex.io> handles billing questions. Call him on +44 20 7946 0958 or write to bob.reyes@globex.io. The last invoice totalled $860.50 and is now 45 days overdue.',
    '',
    'For general support email support@example.com or visit https://help.example.com/portal. Ticket volumes average 1,250 per week across all regions.',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------- key: value -
write(
  'app_settings.txt',
  [
    '# Primary API node',
    'host = api1.example.com',
    'port = 8443',
    'region = eu-west-1',
    'tls = yes',
    '',
    '# Backup node',
    'host = api2.example.com',
    'port = 9443',
    'region = us-east-1',
    'tls = no',
    '',
    '# Cache node',
    'host = cache1.example.com',
    'port = 6379',
    'region = eu-west-1',
    'tls = no',
    '',
  ].join('\n'),
);

// ------------------------------------------------------------ repeated lines -
write(
  'invoices.txt',
  [
    'Invoice #      Date         Client        Amount',
    'INV-1001       2024-01-05   Acme Corp     1,250.00',
    'INV-1002       2024-01-09   Globex        980.50',
    'INV-1003       2024-01-17   Initech       4,300.00',
    'INV-1004       2024-02-02   Acme Corp     725.00',
    'INV-1005       2024-02-11   Umbrella      12,000.00',
    'INV-1006       2024-02-20   Globex        2,450.75',
    '',
  ].join('\n'),
);

// --------------------------------------------------------------------- LOG ---
write(
  'server.log',
  [
    '2024-05-01 09:15:01 INFO  Server started on port 8080',
    '2024-05-01 09:15:02 DEBUG Loaded config from /etc/app.yaml',
    '2024-05-01 09:15:44 WARN  Slow query detected: 1.2s',
    '2024-05-01 09:16:10 ERROR Database connection failed host=db.internal',
    '2024-05-01 09:16:11 INFO  Retrying connection attempt 1',
    '2024-05-01 09:16:15 INFO  Connection restored',
    '2024-05-01 10:00:00 INFO  Scheduled job cleanup finished rows=42',
    '2024-05-01 10:04:31 ERROR Request failed path=/api/orders status=503',
    '2024-05-01 10:04:32 INFO  Retry succeeded path=/api/orders',
    '2024-05-01 11:00:00 INFO  Memory usage 61% heap=344MB',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------------- EML ---
write(
  'invoice.eml',
  [
    'From: Alice Smith <alice@example.com>',
    'To: bob@example.com',
    'Cc: carol@example.com',
    'Subject: =?UTF-8?Q?Q3_sales_report_=E2=80=93_draft?=',
    'Date: Mon, 01 Jul 2024 09:30:00 +0000',
    'Message-ID: <abc123@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hi Bob,',
    '',
    'Q3 revenue: $12,400.50 (+8.25% vs Q2). The caf=C3=A9 menu items sold out =',
    'in every region.',
    '',
    'Mail ops@example.com if the dashboard is slow, or call +1 415 555 0100.',
    '',
    'Regards,',
    'Alice',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------------- RTF ---
write(
  'contact_card.rtf',
  [
    String.raw`{\rtf1\ansi\deff0 {\fonttbl{\f0 Arial;}}`,
    String.raw`\f0\fs24 Name: Dana Fisher\par`,
    String.raw`Company: Contoso Ltd\par`,
    String.raw`Email: dana@contoso.example\par`,
    String.raw`Phone: +1 212 555 0198\par`,
    String.raw`Renewal: 2024-09-30\par`,
    '}',
    '',
  ].join('\n'),
);

// ------------------------------------------------------------------- XLSX ----
const workbook = XLSX.utils.book_new();
const productRows = [
  ['Product', 'Category', 'Units', 'Price', 'Restocked', 'In stock'],
  ['Widget A', 'Widgets', 120, 19.99, new Date('2024-04-02'), true],
  ['Widget B', 'Widgets', 45, 24.5, new Date('2024-04-11'), false],
  ['Gadget X', 'Gadgets', 12, 149.0, new Date('2024-03-28'), true],
  ['Gadget Y', 'Gadgets', 30, 89.95, new Date('2024-05-06'), true],
  ['Doohickey', 'Parts', 500, 4.25, new Date('2024-05-19'), true],
  ['Sprocket', 'Parts', 0, 8.75, new Date('2024-02-14'), false],
];
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(productRows), 'Inventory');
fs.writeFileSync(path.join(samples, 'products.xlsx'), XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }));
written.push('products.xlsx');

// Legacy .xls (BIFF) — SheetJS can write it; skip quietly if this build cannot.
try {
  const legacy = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(legacy, XLSX.utils.aoa_to_sheet(productRows), 'Inventory');
  fs.writeFileSync(path.join(samples, 'legacy.xls'), XLSX.write(legacy, { bookType: 'xls', type: 'buffer' }));
  written.push('legacy.xls');
} catch (error) {
  console.warn('skipping legacy.xls:', error.message);
}

// --------------------------------------------------------------------- DOCX ---
const docx = new JSZip();
docx.file(
  '[Content_Types].xml',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
);
docx.file(
  '_rels/.rels',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
);
const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
docx.file(
  'word/document.xml',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${para('Quarterly planning meeting notes')}
    ${para('Attendees: Alice, Bob and Carol discussed the rollout schedule for the next quarter.')}
    <w:tbl>
      ${row('Team', 'Owner', 'Score')}
      ${row('Sales', 'Dana', '120')}
      ${row('Engineering', 'Ravi', '85')}
      ${row('Support', 'Mia', '40')}
    </w:tbl>
    ${para('Next meeting: 2024-07-15 at 10:00. Budget follow-ups go to finance@example.com.')}
  </w:body>
</w:document>`,
);
const docxBuffer = await docx.generateAsync({ type: 'nodebuffer' });
fs.writeFileSync(path.join(samples, 'meeting_notes.docx'), docxBuffer);
written.push('meeting_notes.docx');

// ---------------------------------------------------------------------- ZIP ---
const zip = new JSZip();
zip.file(
  'sales.csv',
  'region,units,revenue\nNorth,120,4800.00\nSouth,95,3750.50\nEast,140,5610.25\n',
);
zip.file(
  'app.log',
  [
    '2024-05-02 08:00:00 INFO  boot sequence complete',
    '2024-05-02 08:00:04 WARN  cache miss ratio 41%',
    '2024-05-02 08:00:09 INFO  ready to serve traffic',
    '',
  ].join('\n'),
);
zip.file(
  'summary.json',
  `${JSON.stringify(
    {
      generated: '2024-05-02',
      totals: [
        { region: 'North', orders: 41 },
        { region: 'South', orders: 28 },
        { region: 'East', orders: 52 },
      ],
    },
    null,
    2,
  )}\n`,
);
const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
fs.writeFileSync(path.join(samples, 'data_dump.zip'), zipBuffer);
written.push('data_dump.zip');

// ---------------------------------------------------------------------- PDF ---
function escapePdf(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf(cells) {
  // cells: [{ text, x, y, size }]
  const content = cells
    .map((cell) => `BT /F1 ${cell.size} Tf 1 0 0 1 ${cell.x} ${cell.y} Tm (${escapePdf(cell.text)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const pdfRows = [
  ['SKU', 'DESCRIPTION', 'QTY', 'UNIT PRICE'],
  ['W-1001', 'Widget', '10', '19.99'],
  ['G-2002', 'Gadget', '7', '149.00'],
  ['D-3003', 'Doohickey', '130', '4.25'],
  ['S-4004', 'Sprocket', '3', '8.75'],
  ['B-5005', 'Blob', '5', '25.00'],
];
const colX = [72, 200, 380, 470];
const pdfCells = [];
pdfRows.forEach((rowCells, rowIndex) => {
  const y = 700 - rowIndex * 24;
  rowCells.forEach((text, colIndex) => {
    pdfCells.push({ text, x: colX[colIndex], y, size: 11 });
  });
});
fs.writeFileSync(path.join(samples, 'inventory_table.pdf'), buildPdf(pdfCells));
written.push('inventory_table.pdf');

// ---------------------------------------------------------------------- PNG ---
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function renderText(rgb, width, text, x0, y0, scale) {
  let x = x0;
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[' '];
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = x + col * scale + dx;
            const py = y0 + row * scale + dy;
            const offset = (py * width + px) * 3;
            rgb[offset] = 20;
            rgb[offset + 1] = 20;
            rgb[offset + 2] = 24;
          }
        }
      }
    }
    x += 6 * scale;
  }
}

function buildScanPng() {
  const width = 560;
  const height = 400;
  const rgb = Buffer.alloc(width * height * 3, 250);
  const table = [
    ['ITEM', 'QTY', 'PRICE'],
    ['APPLE', '10', '1.50'],
    ['BANANA', '4', '0.75'],
    ['CHERRY', '12', '3.25'],
    ['DATES', '6', '2.10'],
  ];
  const scale = 5;
  const colX = [30, 250, 400];
  table.forEach((rowCells, rowIndex) => {
    const y = 30 + rowIndex * 65;
    rowCells.forEach((text, colIndex) => {
      renderText(rgb, width, text, colX[colIndex], y, scale);
    });
  });

  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 3 + 1)] = 0;
    rgb.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
fs.writeFileSync(path.join(samples, 'scanned_table.png'), buildScanPng());
written.push('scanned_table.png');

// ------------------------------------------------------------ 50MB stress ----
if (process.argv.includes('--large')) {
  const header = 'id,created_at,customer,region,category,units,unit_price,notes\n';
  const regions = ['North', 'South', 'East', 'West'];
  const categories = ['Widgets', 'Gadgets', 'Parts', 'Services'];
  const chunks = [header];
  let size = header.length;
  let id = 1;
  while (size < 50 * 1024 * 1024) {
    const line = `${id},2024-01-${String((id % 28) + 1).padStart(2, '0')},Customer ${id % 997},${
      regions[id % 4]
    },${categories[id % 4]},${(id % 87) + 1},${((id % 900) / 10 + 10).toFixed(2)},note ${id % 53}\n`;
    chunks.push(line);
    size += line.length;
    id += 1;
  }
  fs.writeFileSync(path.join(samples, '.large', 'large_50mb.csv'), chunks.join(''));
  written.push('.large/large_50mb.csv');
}

console.log(`Generated ${written.length} sample files in samples/dev/:`);
for (const name of written) console.log(`  - ${name}`);
