// Price changes: which digits moved and in which direction.
const SHOW = 1600; // ms

// Index of the first character that differs. Different lengths mean the whole number changed.
export function firstChange(before, after) {
  if (before.length !== after.length) return 0;
  let i = 0;
  while (i < after.length && before[i] === after[i]) i++;
  return i;
}

export function createTicks(now = Date.now) {
  const last = new Map(), moves = new Map();
  return {
    // Call with each fresh batch of quotes. Returns true if any price moved.
    update(quotes) {
      let moved = false;
      for (const [id, q] of Object.entries(quotes)) {
        if (q?.last == null) continue;
        const old = last.get(id);
        if (old != null && old !== q.last) { moves.set(id, { from: old, up: q.last > old, until: now() + SHOW }); moved = true; }
        last.set(id, q.last);
      }
      return moved;
    },
    // What to highlight right now, or null.
    get(id) {
      const m = moves.get(id);
      if (!m) return null;
      if (now() >= m.until) { moves.delete(id); return null; }
      return m;
    },
    SHOW,
  };
}
