// Web Worker: shape-aware collage packing with NO DOM access — a faithful copy of the main-thread
// packer in layout.js, so a view can be packed off-thread (on hover) and rendered instantly on
// click. Input: slim items ({__idx, mask, width, height, searchW}) + a config of the layout
// tunables + W + viewportH. Output: placements + the resulting occupancy-grid state, so the main
// thread can render them and continue scrolling seamlessly.
let cfg = null;

function rotExtent(w, h, rot) {
  const r = (rot * Math.PI) / 180;
  const ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
  return [w * ca + h * sa, w * sa + h * ca];
}

function makeSize(it, base) {
  const ar = (it.width || 1) / (it.height || 1);
  let mult;
  if (Math.random() < cfg.HERO_CHANCE) mult = cfg.HERO_MULT[0] + Math.random() * (cfg.HERO_MULT[1] - cfg.HERO_MULT[0]);
  else mult = cfg.NORM_MULT[0] + Math.pow(Math.random(), cfg.NORM_SKEW) * (cfg.NORM_MULT[1] - cfg.NORM_MULT[0]);
  mult *= it.searchW || 1;                                  // 1 for browse (undefined), search-weighted otherwise
  const nativeDim = Math.min(Math.max(it.width || 1, it.height || 1), cfg.OPTIMIZED_MAX);
  const dim = Math.min(base * mult, Math.min(cfg.W, cfg.REF_H) * cfg.MAX_DIM_FRAC, nativeDim);
  const w = ar >= 1 ? dim : dim * ar;
  const h = ar >= 1 ? dim / ar : dim;
  return { it, w, h };
}

function ensureRows(S, needed) {
  const cap = S.occ.length / S.cols;
  if (needed > cap) { const next = new Uint8Array(S.cols * Math.max(cap * 2, needed)); next.set(S.occ); S.occ = next; }
  if (needed > S.occRows) S.occRows = needed;
}

function place(S, p, yMin, yMax) {
  const m = p.it.mask, W = S.W, cols = S.cols, GRID = cfg.GRID;
  for (let t = 0; t < cfg.PLACE_TRIES; t++) {
    const rot = (Math.random() * 2 - 1) * cfg.MAX_ROT;
    const rad = (rot * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const [ew, eh] = rotExtent(p.w, p.h, rot);
    if (ew > W) continue;
    const cx = ew / 2 + Math.random() * (W - ew);
    const cyLow = Math.max(yMin, eh / 2), cyHigh = Math.max(cyLow, yMax);
    const cy = cyLow + Math.random() * (cyHigh - cyLow);
    const gx0 = Math.max(0, Math.floor((cx - ew / 2) / GRID));
    const gy0 = Math.max(0, Math.floor((cy - eh / 2) / GRID));
    const gx1 = Math.min(cols - 1, Math.floor((cx + ew / 2) / GRID));
    const gy1 = Math.min(S.occRows - 1, Math.floor((cy + eh / 2) / GRID));
    const cells = []; let hit = false;
    for (let gy = gy0; gy <= gy1 && !hit; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const bx = (gx + 0.5) * GRID - cx, by = (gy + 0.5) * GRID - cy;
        const lx = bx * c + by * s, ly = -bx * s + by * c;
        const u = (lx / p.w + 0.5) * m.mw, v = (ly / p.h + 0.5) * m.mh;
        if (u < 0 || v < 0 || u >= m.mw || v >= m.mh) continue;
        if (!m.bits[(v | 0) * m.mw + (u | 0)]) continue;
        const idx = gy * cols + gx;
        if (S.occ[idx]) { hit = true; break; }
        cells.push(idx);
      }
    }
    if (hit) continue;
    return { x: cx - p.w / 2, y: cy - p.h / 2, rot, cells };
  }
  return null;
}

function markOccupied(S, cells) {
  const cols = S.cols, GAP = cfg.GAP_CELLS, rows = S.occ.length / cols;
  for (const idx of cells) {
    S.occ[idx] = 1;
    const gx = idx % cols, gy = (idx / cols) | 0;
    for (let d = 1; d <= GAP; d++) {
      if (gx >= d) S.occ[idx - d] = 1;
      if (gx < cols - d) S.occ[idx + d] = 1;
      if (gy >= d) S.occ[idx - d * cols] = 1;
      if (gy < rows - d) S.occ[idx + d * cols] = 1;
    }
  }
}

onmessage = (e) => {
  const { id, items, config } = e.data;
  cfg = config;
  const W = cfg.W, REF_H = cfg.REF_H, BAND_H = cfg.BAND_H, refArea = W * REF_H;
  const S = { occ: new Uint8Array(0), cols: Math.max(1, Math.ceil(W / cfg.GRID)), occRows: 0, W };
  const base = Math.sqrt(cfg.COVER * (refArea / cfg.OBJ_PER_REF));
  const n = Math.max(1, Math.round((BAND_H * W) / (refArea / cfg.OBJ_PER_REF)));   // bandCount
  const target = cfg.viewportH * 1.15;                       // match reset()'s first fill
  let filledY = 0, order = 0, used = 0, guard = 0;
  const placements = [];
  while (filledY < target && guard++ < 8 && used < items.length) {
    const bandTop = filledY, bandBottom = bandTop + BAND_H;
    ensureRows(S, Math.ceil((bandBottom + Math.min(W, REF_H) * cfg.MAX_DIM_FRAC) / cfg.GRID));
    const batch = [];
    for (let i = 0; i < n && used < items.length; i++) batch.push(makeSize(items[used++], base));
    batch.sort((a, b) => b.w * b.h - a.w * a.h);
    for (let p of batch) {
      let put = place(S, p, bandTop, bandBottom), sh = 0;
      while (!put && sh < cfg.SHRINK_STEPS) { p = { it: p.it, w: p.w * cfg.SHRINK, h: p.h * cfg.SHRINK }; put = place(S, p, bandTop, bandBottom); sh++; }
      if (!put) continue;
      markOccupied(S, put.cells);
      placements.push({ i: p.it.__idx, x: put.x, y: put.y, rot: put.rot, w: p.w, h: p.h, z: order++ });
    }
    filledY = bandBottom;
  }
  postMessage({ id, placements, occ: S.occ, occRows: S.occRows, filledY, order, used }, [S.occ.buffer]);
};
