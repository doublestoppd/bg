// The main navigation menu. Each entry becomes one link in the header.
//
// To replace a text button with your own artwork, add an `image` property
// pointing at a file in src/public/images/, for example:
//   { label: 'My Pets', href: '/pets', image: '/images/nav/pets.png' }
// The label is still used as the image's alt text.

const alwaysShown = [
  { label: 'Home', href: '/' },
];

const forGuests = [
  { label: 'Log In', href: '/login' },
  { label: 'Register', href: '/register' },
];

const forPlayers = [
  { label: 'My Pets', href: '/pets' },
  { label: 'Adopt a Pet', href: '/pets/adopt' },
];

// Returns the menu entries a visitor should see. Logged-in players get the
// game links; guests get the account links.
export function navigationFor(currentUser) {
  if (currentUser) {
    return [...alwaysShown, ...forPlayers];
  }
  return [...alwaysShown, ...forGuests];
}
