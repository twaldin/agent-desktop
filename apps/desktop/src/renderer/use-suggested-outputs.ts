import { useEffect, useLayoutEffect, useReducer, useState } from 'react';
import { SuggestedOutputs, type SuggestedOutputOwner } from './suggested-outputs';
export function useSuggestedOutputs(owner: SuggestedOutputOwner) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [outputs] = useState(() => new SuggestedOutputs(redraw));
  // Transcript projection allocates a new array on render; only changed entry IDs restart reads.
  const entryIds = JSON.stringify(owner.entryIds);
  useLayoutEffect(() => { outputs.start(); return () => outputs.dispose(); }, [outputs]);
  useLayoutEffect(() => { outputs.observe(owner); }, [outputs, owner.hostId, owner.sessionId, owner.connected, owner.active, entryIds, owner.bridge]);
  useEffect(() => {
    if (!outputs.enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => { await outputs.read(); if (!stopped) timer = setTimeout(read, 2000); };
    void read();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [outputs, owner.hostId, owner.sessionId, owner.connected, owner.active, entryIds, owner.bridge]);
  return outputs;
}
