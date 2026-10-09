// The pet statistics, in one place. Everything that lists or labels them
// (pet rules, item effects, the feeding message, the templates) reads
// this, so adding a stat is a change to one file.
export const STAT_NAMES = ['hunger', 'happiness', 'health'];

export const STAT_LABELS = {
  hunger: 'Hunger',
  happiness: 'Happiness',
  health: 'Health',
};
