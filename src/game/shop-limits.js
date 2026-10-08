// Every numerical anti-abuse limit for shopping, in one place. See
// docs/SHOPS.md ("Protections") for what each one does and why.
//
// These are starting values for a small game. Raise them if legitimate
// players report running into them; lower them if the activity log shows
// abuse getting through.

export const SHOP_LIMITS = {
  // Successful purchases of limited stock per account in any rolling hour.
  // Essentials are not counted: they never sell out, so there is nothing to
  // monopolise, and a player must always be able to feed their pets.
  listingPurchasesPerHour: 30,

  // Loading a shop page (browsing or refreshing).
  shopViewsPerMinutePerAccount: 60,
  // The per-IP allowance is larger than the per-account one so that a
  // household or a mobile network sharing one address is not blocked
  // before any single account in it would be.
  shopViewsPerMinutePerIp: 120,

  // Submitting a buy form, successful or not.
  purchaseAttemptsPerMinutePerAccount: 20,

  // Refused purchases (sold out, limit hit, bad form ...) in a five-minute
  // window. Past this, buying is paused for the rest of the window: a
  // human hitting Buy on a sold-out item a few times never gets near it,
  // a script hammering the shelves does.
  failedPurchasesPerFiveMinutes: 10,
};

// How long shop_activity_log rows are kept before the scheduler deletes them.
export const ACTIVITY_LOG_RETENTION_DAYS = 30;
