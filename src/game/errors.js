// Thrown by game functions when a player's request breaks a rule: a name
// that is too long, not enough coins, too many pets. Routes catch this and
// show the message on the form. Any other kind of error is a bug and goes
// to the generic error page.
export class GameRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameRuleError';
  }
}
