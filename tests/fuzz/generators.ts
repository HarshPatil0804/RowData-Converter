/**
 * Six clean ground-truth generators in different domains (Task B).
 *
 * Each generator produces the *ideal* clean table: canonical values, ISO
 * dates, real numbers, booleans as booleans, nulls where data is missing.
 * The injectors then mess a copy of it up; the pipeline must recover this
 * ground truth cell by cell.
 *
 * Constraints every generator obeys (so no rule fires *by accident*):
 *  - text values contain no parentheses, "=" or composite separators (those
 *    belong to the R16/R5/R17 injectors, not to clean data);
 *  - headers are human-style ("Order ID") but free of " / ", " - " and " (";
 *  - every table has a unique-integer id column, ≥1 date, ≥1 boolean,
 *    ≥1 numeric column with decimals, and category columns with 3–12 values;
 *  - 40–80 rows per table, a few genuine nulls in optional columns.
 */

import type { Cell } from '../../src/types';
import type { RNG } from './random';

export interface GroundTruth {
  header: string[];
  rows: Cell[][];
}

const FIRST = [
  'Aarav', 'Bianca', 'Chen', 'Daniela', 'Elias', 'Farah', 'Greta', 'Hiro',
  'Imani', 'Jonas', 'Keiko', 'Lucas', 'Maya', 'Noor', 'Omar', 'Priya',
  'Quinn', 'Rosa', 'Sven', 'Tara', 'Umar', 'Vera', 'Wei', 'Yara',
];
const LAST = [
  'Adams', 'Bauer', 'Costa', 'Dubois', 'Eriksen', 'Fernandez', 'Gupta',
  'Haddad', 'Ivanov', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Novak',
  'Okafor', 'Petrov', 'Quintana', 'Rossi', 'Sato', 'Tanaka', 'Ueda', 'Vargas',
];
const CITIES = [
  'Amsterdam', 'Berlin', 'Cairo', 'Dublin', 'Osaka', 'Lisbon', 'Nairobi',
  'Oslo', 'Paris', 'Quito', 'Rome', 'Seoul', 'Tokyo', 'Vienna', 'Zurich',
  'Toronto', 'Manila', 'Perth',
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Random ISO date between 2024-01-01 and 2026-12-31 (day-first writing later). */
function isoDate(rng: RNG): string {
  const year = rng.int(2024, 2026);
  const month = rng.int(1, 12);
  const day = rng.int(1, 28); // 28 keeps every month valid without extra checks
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function person(rng: RNG): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

function money(rng: RNG, min: number, max: number): number {
  return Math.round((min + rng.next() * (max - min)) * 100) / 100;
}

/** Null with a small probability – real files always have gaps. */
function maybe<T>(rng: RNG, value: T, pNull = 0.06): T | null {
  return rng.chance(pNull) ? null : value;
}

function rows(n: number, build: (index: number) => Cell[]): Cell[][] {
  return Array.from({ length: n }, (_unused, index) => build(index));
}

// --------------------------------------------------------------- domains ---

function retailOrders(rng: RNG): GroundTruth {
  const products = ['Desk Lamp', 'Office Chair', 'Standing Desk', 'Monitor Arm', 'Keyboard', 'Webcam'];
  const regions = ['North', 'South', 'East', 'West'];
  const notes = ['rush delivery', 'gift wrap requested', 'invoice emailed', 'call before dispatch'];
  const count = rng.int(45, 70);
  const header = ['Order ID', 'Order Date', 'Product', 'Region', 'Unit Price', 'Quantity', 'Express', 'Notes'];
  const rowsOut = rows(count, (i) => [
    1000 + i,
    isoDate(rng),
    rng.pick(products),
    rng.pick(regions),
    money(rng, 4.5, 499.99),
    rng.int(1, 24),
    rng.chance(0.4),
    maybe(rng, rng.pick(notes), 0.12),
  ]);
  return { header, rows: rowsOut };
}

function schoolMarks(rng: RNG): GroundTruth {
  const subjects = ['Algebra', 'Biology', 'Chemistry', 'Drawing', 'English', 'Geography', 'History', 'Physics'];
  const sections = ['A', 'B', 'C', 'D'];
  const count = rng.int(50, 75);
  const header = ['Roll No', 'Student', 'Section', 'Subject', 'Marks', 'Exam Date', 'Absent', 'Remark'];
  const rowsOut = rows(count, (i) => [
    2000 + i,
    person(rng),
    rng.pick(sections),
    rng.pick(subjects),
    rng.int(0, 100),
    isoDate(rng),
    rng.chance(0.08),
    maybe(rng, rng.pick(['needs recheck', 'top of class', 'improved', 'extra credit']), 0.5),
  ]);
  return { header, rows: rowsOut };
}

function payroll(rng: RNG): GroundTruth {
  const departments = ['Finance', 'Engineering', 'Marketing', 'Operations', 'Support', 'Legal'];
  const count = rng.int(45, 65);
  const header = ['Emp ID', 'Employee', 'Department', 'Basic Pay', 'Bonus', 'Deduction', 'Pay Date', 'Full Time'];
  const rowsOut = rows(count, (i) => {
    const basic = money(rng, 24000, 145000);
    return [
      3000 + i,
      person(rng),
      rng.pick(departments),
      basic,
      rng.chance(0.75) ? money(rng, 500, 22000) : null,
      money(rng, 0, 9000),
      isoDate(rng),
      rng.chance(0.82),
    ];
  });
  return { header, rows: rowsOut };
}

function shipments(rng: RNG): GroundTruth {
  const carriers = ['Skyline', 'Oceanic', 'Redline', 'Swift Post'];
  const statuses = ['Pending', 'In Transit', 'Delivered', 'Returned', 'Cancelled'];
  const count = rng.int(45, 70);
  const header = ['Shipment ID', 'Ship Date', 'Origin', 'Destination', 'Weight KG', 'Carrier', 'Priority', 'Status'];
  const rowsOut = rows(count, (i) => [
    4000 + i,
    isoDate(rng),
    rng.pick(CITIES),
    rng.pick(CITIES),
    money(rng, 0.2, 850),
    rng.pick(carriers),
    rng.chance(0.3),
    rng.pick(statuses),
  ]);
  return { header, rows: rowsOut };
}

function libraryLoans(rng: RNG): GroundTruth {
  const titles = [
    'Silent Harbor', 'The Last Cartographer', 'Paper Cities', 'Winter Circuit',
    'Glass Orchard', 'Signal Fire', 'The Quiet Machine', 'Northbound',
  ];
  const genres = ['Fiction', 'History', 'Science', 'Biography', 'Travel', 'Poetry', 'Comics'];
  const count = rng.int(45, 70);
  const header = ['Book ID', 'Title', 'Author', 'Genre', 'Borrowed On', 'Due On', 'Fine', 'Returned'];
  const rowsOut = rows(count, (i) => [
    5000 + i,
    rng.pick(titles),
    person(rng),
    rng.pick(genres),
    isoDate(rng),
    isoDate(rng),
    maybe(rng, rng.chance(0.35) ? money(rng, 1, 240) : 0, 0.05),
    rng.chance(0.7),
  ]);
  return { header, rows: rowsOut };
}

function hotelBookings(rng: RNG): GroundTruth {
  const roomTypes = ['Single', 'Double', 'Suite', 'Deluxe'];
  const count = rng.int(45, 70);
  const header = ['Booking ID', 'Guest', 'Room Type', 'Check In', 'Nights', 'Nightly Rate', 'City', 'Paid'];
  const rowsOut = rows(count, (i) => [
    6000 + i,
    person(rng),
    rng.pick(roomTypes),
    isoDate(rng),
    rng.int(1, 14),
    money(rng, 45, 720),
    rng.pick(CITIES),
    rng.chance(0.72),
  ]);
  return { header, rows: rowsOut };
}

export interface Domain {
  name: string;
  generate: (rng: RNG) => GroundTruth;
}

export const DOMAINS: Domain[] = [
  { name: 'retail orders', generate: retailOrders },
  { name: 'school marks', generate: schoolMarks },
  { name: 'payroll', generate: payroll },
  { name: 'shipments', generate: shipments },
  { name: 'library loans', generate: libraryLoans },
  { name: 'hotel bookings', generate: hotelBookings },
];
