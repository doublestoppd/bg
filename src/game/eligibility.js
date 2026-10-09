import { GameRuleError } from './errors.js';
import { findActiveRestriction } from '../db/restrictions.js';
import { countPetsByOwner } from '../db/pets.js';

// Who may buy from a shop. Two layers:
//   * every listing: the account must have no shopping restriction in
//     force (imposed by an administrator, with a reason);
//   * listings whose pool entry declares `eligibility`: the rules there,
//     each one checkable from data the game already has. Ordinary food
//     should never declare any, so a new player can always buy it.
//
// Rules supported today: minAccountAgeHours and requiresPet. Email
// verification and a progression requirement are future work; they need
// features the game does not have yet.
export async function assertEligible(db, user, entry, now = new Date()) {
  const restriction = await findActiveRestriction(db, user.id);
  if (restriction) {
    throw new GameRuleError(`Your shopping is suspended: ${restriction.reason}`, 'restricted');
  }

  const rules = (entry && entry.eligibility) || {};
  if (rules.minAccountAgeHours) {
    const ageHours = (now - new Date(user.created_at)) / (60 * 60 * 1000);
    if (ageHours < rules.minAccountAgeHours) {
      throw new GameRuleError(`${entry.item.name} is only sold to citizens of at least ${describeHours(rules.minAccountAgeHours)}' standing.`, 'ineligible');
    }
  }
  if (rules.requiresPet) {
    if ((await countPetsByOwner(db, user.id)) === 0) {
      throw new GameRuleError(`${entry.item.name} is only sold to people with a pet at home.`, 'ineligible');
    }
  }
}

function describeHours(hours) {
  return hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
}
