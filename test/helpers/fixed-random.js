// Deterministic stand-ins for the secure randomness restocking uses.

// Always returns the low end of every range.
export const lowRandom = { int: (min) => min };

// Always returns the high end of every range.
export const highRandom = { int: (min, max) => max };

// Returns the given values in order (clamped into range), then the low end.
export function sequenceRandom(values) {
  const queue = [...values];
  return {
    int: (min, max) => {
      if (queue.length === 0) return min;
      return Math.max(min, Math.min(max, queue.shift()));
    },
  };
}

// A small seeded generator (mulberry32) for "many draws" tests: varied
// but exactly repeatable, so a failure can be reproduced.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return {
    int: (min, max) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return min + Math.floor(unit * (max - min + 1));
    },
  };
}
