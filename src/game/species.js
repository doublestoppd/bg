// The creatures a player can adopt. This is hand-edited design content:
// add an object here and the species appears on the adoption page.
//
// `image` is the portrait shown on the pet's page. Set it to a path such as
// '/images/species/wompus.png' once the artwork exists; until then the page
// shows a placeholder box with the species name.

const species = [
  {
    slug: 'wompus',
    name: 'Wompus',
    description: 'A round, woolly creature that hums when content and sulks loudly when not.',
    image: null,
  },
  {
    slug: 'snibble',
    name: 'Snibble',
    description: 'Small, quick and nosy. Collects shiny pebbles and refuses to explain why.',
    image: null,
  },
  {
    slug: 'gloop',
    name: 'Gloop',
    description: 'A patient blob of uncertain depth. Enjoys puddles and long silences.',
    image: null,
  },
];

export function allSpecies() {
  return species;
}

export function findSpecies(slug) {
  return species.find((entry) => entry.slug === slug) || null;
}
