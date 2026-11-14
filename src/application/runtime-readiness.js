/** Prevents late client events from reopening message admission after shutdown. */
export function createRuntimeReadinessGate() {
  let accepting = false;
  let shutdownStarted = false;

  return Object.freeze({
    markReady() {
      if (shutdownStarted) return false;
      accepting = true;
      return true;
    },
    stop() {
      shutdownStarted = true;
      accepting = false;
    },
    canAccept() {
      return accepting;
    },
  });
}
