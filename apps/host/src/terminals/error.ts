/** Safe to import from standalone packaging/install scripts before dependencies exist. */
export class TerminalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TerminalError"; }
}
