import { useEffect, useLayoutEffect, useReducer, useState } from 'react';
import { SuggestedOutputs, type SuggestedOutputOwner } from './suggested-outputs';
export function useSuggestedOutputs(owner: SuggestedOutputOwner) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [outputs] = useState(() => new SuggestedOutputs(redraw));
  const identity = JSON.stringify([owner.hostId, owner.sessionId, owner.connected, owner.active, owner.entryIds]);
  useLayoutEffect(() => { outputs.start(); return () => outputs.dispose(); }, [outputs]);
  useLayoutEffect(() => { outputs.observe(owner); }, [outputs, identity, owner.bridge]);
  useEffect(() => {
    if (!outputs.enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => { await outputs.read(); if (!stopped) timer = setTimeout(read, 2000); };
    void read();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [outputs, identity, owner.bridge]);
  return outputs;
}
