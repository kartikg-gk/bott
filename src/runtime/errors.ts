/**
 * A bot could not start because of how it is set up, such as a missing model key. The message
 * says what to change and carries no secret, so it is shown to the person as it is.
 */
export class SetupError extends Error {
  override name = "SetupError";
}
