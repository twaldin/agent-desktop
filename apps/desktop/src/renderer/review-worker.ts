// Force Vite to bundle Pierre's worker entry rather than treating its package
// declaration as a removable side-effect-only import.
import PierreWorker from "@pierre/diffs/worker/worker.js?worker";

export default PierreWorker;
