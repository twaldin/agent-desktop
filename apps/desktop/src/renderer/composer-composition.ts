type ComposerKey = Pick<KeyboardEvent, "key" | "code" | "keyCode" | "isComposing" | "timeStamp">;

/** Keeps an IME-confirming native key from being replayed as an application action. */
export class ComposerCompositionGuard {
  private enterTimeStamp: number | undefined;
  private enterCode = "";

  reset(): void {
    this.enterTimeStamp = undefined;
    this.enterCode = "";
  }

  classify(event: ComposerKey, composing = false): "composition" | "replay" | undefined {
    const enter = event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
    if (composing || event.isComposing || event.keyCode === 229) {
      if (enter) {
        this.enterTimeStamp = event.timeStamp;
        this.enterCode = event.code;
      }
      return "composition";
    }
    // macOS can replay the confirming Enter after compositionend and keyup,
    // retaining its native timestamp. A new physical key has a new identity.
    if (enter && event.timeStamp === this.enterTimeStamp && event.code === this.enterCode) return "replay";
    this.reset();
    return undefined;
  }
}
