/* core.js — the rules of the game. No DOM, no network, no globals.
   Shared by the solo game and the multiplayer one so both always agree. */

/* ─────────────────────── deterministic deck ───────────────────────
   Every device shuffles the same song list with the same seed, so the
   room agrees on the running order without sending 1,000 ids over the wire. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(list, seed) {
  const r = mulberry32(seed), out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

/* ───────────────────────── timeline rules ───────────────────────── */

/** The cards on a board, oldest first. */
export const sortBoard = cards => cards.slice().sort((a, b) => a.year - b.year);

/** Slot i sits before board[i]; slot board.length is after everything. */
export function slotLabel(board, i) {
  if (!board.length) return "anywhere";
  if (i === 0) return `before ${board[0].year}`;
  if (i === board.length) return `after ${board[board.length - 1].year}`;
  return `${board[i - 1].year} – ${board[i].year}`;
}

export function slotIsCorrect(board, i, year) {
  const loOk = i === 0 || year >= board[i - 1].year;
  const hiOk = i === board.length || year <= board[i].year;
  return loOk && hiOk;
}

/** Every slot the song could legitimately go in — more than one when years tie. */
export function correctSlots(board, year) {
  const out = [];
  for (let i = 0; i <= board.length; i++) if (slotIsCorrect(board, i, year)) out.push(i);
  return out;
}

/* ───────────────────────── name matching ───────────────────────── */
const LEADING_ARTICLE = /^(the|a|an)\s+/i;

export function normName(s) {
  return (s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")              // (Remastered), [Explicit]
    .replace(/\b(feat|ft|featuring|with)\b.*/g, " ")
    .replace(/\band\b/g, "&")
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(LEADING_ARTICLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0..1 similarity, Levenshtein ratio. */
export function ratio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Does the player's text name this title/artist? Checks the chart name, the
 *  streaming services' names, and any wording previously counted as correct.
 *  With splitArtists, naming any one artist of a collaboration is enough. */
export function namesIt(input, canonical, alts, splitArtists, strict = 0.82) {
  const g = normName(input);
  if (g.length < 2) return false;
  const names = [canonical].concat(alts || []).filter(Boolean);
  const targets = names.map(normName);
  if (splitArtists) {
    for (const t of names) {
      for (const part of t.split(/,|&|\band\b|\bfeaturing\b|\bfeat\.?\b|\bwith\b|\bx\b|\bvs\.?\b/i)) {
        const p = normName(part);
        if (p.length > 2) targets.push(p);
      }
    }
  }
  // A substring match ("Another Brick in the Wall" for "...,Part II") counts only
  // when the two are close in length — and barely at all in strict mode.
  const subMin = strict >= 0.9 ? 0.97 : 0.7;
  for (const t of targets) {
    if (!t) continue;
    if (g === t) return true;
    if (t.length >= 7 && (t.includes(g) || g.includes(t)) &&
        Math.min(g.length, t.length) / Math.max(g.length, t.length) > subMin) return true;
    if (ratio(g, t) >= strict) return true;
  }
  return false;
}

/* ──────────────── answers you chose to count as correct ────────────────
   Kept per song in this browser, so a wording you accepted once keeps
   working. Multiplayer shares them through the room as well. */
const ALIAS_KEY = "timeline.aliases.v1";

export function loadAliases() {
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY)) || {}; }
  catch (_) { return {}; }                 // file:// has no storage; fine
}

export function saveAliases(store) {
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(store)); } catch (_) {}
}

export function aliasesFor(store, songId) {
  const e = store[songId];
  return { t: (e && e.t) || [], a: (e && e.a) || [] };
}

export function addAlias(store, songId, field, text) {
  const e = store[songId] || (store[songId] = { t: [], a: [] });
  if (!e[field]) e[field] = [];
  if (!e[field].includes(text)) e[field].push(text);
  saveAliases(store);
  return store;
}

/* ─────────────────────────── scoring ─────────────────────────── */

/** Judge one submission. Returns plain data so every device shows the same
 *  verdict without recomputing it. */
export function judge({ song, board, slot, titleIn, artistIn, naming, strict, alias }) {
  const ok = correctSlots(board, song.year);
  const al = alias || { t: [], a: [] };
  const yearOk = ok.includes(slot);
  const titleOk  = !!(naming && titleIn  &&
    namesIt(titleIn,  song.title,  (song.altT || []).concat(al.t), false, strict));
  const artistOk = !!(naming && artistIn &&
    namesIt(artistIn, song.artist, (song.altA || []).concat(al.a), true,  strict));
  return {
    songId: song.id, slot, correct: ok,
    yearOk, titleOk, artistOk,
    tokenWon: yearOk && titleOk && artistOk,
    named: titleOk && artistOk,
    titleIn: titleIn || "", artistIn: artistIn || "",
    overrodeTitle: false, overrodeArtist: false, overridden: false,
  };
}

/** True when the player typed something that was marked wrong — a near miss
 *  they may want to overrule. */
export function hasNearMiss(r, naming) {
  return !!(naming && r && !r.overridden &&
            ((r.titleIn && !r.titleOk) || (r.artistIn && !r.artistOk)));
}
