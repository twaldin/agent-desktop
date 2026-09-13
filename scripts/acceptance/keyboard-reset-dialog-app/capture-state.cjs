// A state transition must not reuse the prior native screenshot. This catches
// stale captures; it does not certify every pixel or reference parity.
function assertCaptureTransition(previous, current) {
  if (!previous) return;
  const changed = previous.state.open !== current.state.open || previous.state.modal !== current.state.modal;
  if (changed && previous.sha256 === current.sha256) {
    throw new Error('Native capture repeated the previous frame across a dialog state transition.');
  }
}
module.exports = { assertCaptureTransition };
