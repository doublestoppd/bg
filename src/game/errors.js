// Thrown by game functions when a player's request breaks a rule: a name
// that is too long, not enough coins, too many pets. Routes catch this and
// show the message on the form. Any other kind of error is a bug and goes
// to the generic error page.
//
// `code` is a short machine-readable label for the kind of refusal
// ('sold_out', 'expired_listing' ...) used when logging shop activity;
// it defaults to 'rule' and is never shown to players.
export class GameRuleError extends Error {
  constructor(message, code = 'rule') {
    super(message);
    this.name = 'GameRuleError';
    this.code = code;
  }
}
