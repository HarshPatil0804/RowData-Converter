/**
 * Deterministic pseudo-randomness for the fuzz harness.
 *
 * Every case is reproducible from its seed: same seed → same messy file →
 * same accuracy numbers. mulberry32 is small, fast and stable across runs.
 */

export interface RNG {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick (throws on an empty list). */
  pick<T>(items: readonly T[]): T;
  /** `count` distinct picks (or all of them when count >= length). */
  pickMany<T>(items: readonly T[], count: number): T[];
  /** Fisher–Yates copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function makeRng(seed: number): RNG {
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const chance = (p: number): boolean => next() < p;
  const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const pickMany = <T,>(items: readonly T[], count: number): T[] =>
    count >= items.length ? [...items] : shuffle(items).slice(0, count);

  return { next, int, chance, pick, pickMany, shuffle };
}

/** Stable string → 32-bit hash (used to seed a case from its name). */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
