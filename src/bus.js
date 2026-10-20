// Tiny event bus. match.js / netsync.js emit; UI modules subscribe.
const handlers = new Map();

export const bus = {
  on(evt, fn){
    if(!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt).delete(fn);
  },
  off(evt, fn){ const s = handlers.get(evt); if(s) s.delete(fn); },
  emit(evt, payload){
    const s = handlers.get(evt);
    if(!s) return;
    for(const fn of [...s]){
      try{ fn(payload); } catch(err){ console.error('[bus]', evt, err); }
    }
  },
};
