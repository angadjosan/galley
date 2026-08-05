/**
 * Deterministic pseudo-randomness.
 *
 * Stress tests need randomness to find interleavings and determinism to
 * reproduce the one that failed. `Math.random()` gives the first and forbids the
 * second, so every randomized test in this repo takes an {@link Rng} seeded from
 * a constant printed in the failure message.
 *
 * The generator is a 64-bit LCG (the Knuth/MMIX constants), taking the high
 * bits — the low bits of an LCG have short periods and would bias small ranges.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [0, boundExclusive). */
  int(boundExclusive: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher–Yates shuffle. Returns the same array. */
  shuffle<T>(items: T[]): T[];
  readonly seed: bigint;
}

const MULTIPLIER = 6364136223846793005n;
const INCREMENT = 1442695040888963407n;
const MASK = (1n << 64n) - 1n;

export function makeRng(seed: number | bigint = 0x5eed): Rng {
  let state = (BigInt(seed) ^ 0x9e3779b97f4a7c15n) & MASK;
  const originalSeed = BigInt(seed);

  const nextBits = (): number => {
    state = (state * MULTIPLIER + INCREMENT) & MASK;
    // High 32 bits: the low bits of an LCG cycle far too fast to be uniform.
    return Number((state >> 32n) & 0xffffffffn);
  };

  const rng: Rng = {
    seed: originalSeed,
    float: () => nextBits() / 0x100000000,
    int: (bound: number) => {
      if (!Number.isInteger(bound) || bound <= 0) {
        throw new RangeError(`bound must be a positive integer, got ${bound}`);
      }
      return Math.floor(rng.float() * bound);
    },
    chance: (p: number) => rng.float() < p,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('cannot pick from an empty array');
      return items[rng.int(items.length)]!;
    },
    shuffle: <T,>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const a = items[i]!;
        items[i] = items[j]!;
        items[j] = a;
      }
      return items;
    },
  };
  return rng;
}

/** Shared instance for non-test callers (jitter). Seeded once per process. */
export const defaultRng: Rng = makeRng(BigInt(Math.floor(Date.now() * Math.random())));
