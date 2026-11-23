/* app.js — screens, turns and rendering.

   One state object drives both modes. Solo keeps it in memory; multiplayer
   keeps it in a Firebase room and every device renders the same thing. All
   the rules live in core.js so the two can never drift apart. */

import * as C from "./core.js";

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const vals = o => Object.values(o || {});
/** Selects can hand back "" (and so NaN) if their value was set out of range;
 *  a NaN target would silently mean "no win condition". */
const intOr = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
const numOr = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

/* ─────────────────────────── songs ───────────────────────────
   The data file holds more than one deck — English-language hits and
   Spanish-language ones — and a game plays whichever its settings name.
   Cards are looked up across all of them, so a game already under way
   still renders if the setting changes underneath it. */
const ALL_SONGS = (window.SONG_DATA || []).filter(s => s && s.year && (s.preview || s.dz));
const BY_ID = new Map(ALL_SONGS.map(s => [s.id, s]));

const BANK_LABELS = { en: "English-language hits", es: "Spanish-language hits" };
const DEFAULT_BANK = "en";

/** Every deck there are songs for, in a fixed order, with a line about each. */
const BANKS = Object.keys(BANK_LABELS)
  .map(id => {
    const songs = ALL_SONGS.filter(s => (s.bank || DEFAULT_BANK) === id);
    if (!songs.length) return null;
    const years = songs.map(s => s.year);
    return { id, label: BANK_LABELS[id], songs,
             min: Math.min(...years), max: Math.max(...years),
             years: new Set(years).size };
  })
  .filter(Boolean);

const NO_BANK = { id: DEFAULT_BANK, label: BANK_LABELS[DEFAULT_BANK], songs: [],
                  min: 0, max: 0, years: 0 };
const bankOr = id => BANKS.find(b => b.id === id)
                  || BANKS.find(b => b.id === DEFAULT_BANK) || BANKS[0] || NO_BANK;
/** The deck this game is playing. */
const songsFor = id => bankOr(id).songs;
const gameBank = () => (G && G.settings && G.settings.bank) || DEFAULT_BANK;

/** Fill a <select> with the decks on offer, starting from the last choice. */
function fillBankSelect(sel, chosen) {
  if (!sel) return;
  const want = BANKS.map(b => b.id).join(",");
  if (sel.dataset.banks !== want) {
    sel.dataset.banks = want;
    sel.innerHTML = "";
    for (const b of BANKS) {
      const o = document.createElement("option");
      o.value = b.id;
      o.textContent = `${b.label} — ${b.songs.length} songs, ${b.min}–${b.max}`;
      sel.appendChild(o);
    }
  }
  sel.value = chosen || P.bank || DEFAULT_BANK;
  if (!sel.value) sel.value = (BANKS[0] || {}).id || DEFAULT_BANK;
  sel.parentElement.hidden = BANKS.length < 2;
}

/* ──────────────── this device's own preferences ──────────────── */
const PREFS_KEY = "timeline.prefs.v1";
const P = Object.assign({ previewLen: 0, volume: 0.8, strict: 0.82, bank: DEFAULT_BANK }, (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; }
})());
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(P)); } catch (_) {} };

let aliases = C.loadAliases();

/* ─────────────────────────── state ─────────────────────────── */
let G = null;            // the game, identical in shape for solo and multiplayer
let room = null;         // a net.Room when multiplayer, else null
let myId = "solo";
let myName = "You";
let net = null;          // the lazily imported net.js module
let deckCache = { seed: null, bank: null, deck: [] };
let lastDeckIdx = -1;
let endShownFor = null;
let freshId = null;                 // card to animate in, once
let seen = { phase: null, placed: null, owner: null };

const multiplayer = () => !!room;
const isMine = () => !G || G.turn === myId;
const isHost = () => !G || G.hostId === myId || !multiplayer();

function deck() {
  const bank = gameBank();
  if (deckCache.seed !== G.seed || deckCache.bank !== bank) {
    deckCache = { seed: G.seed, bank, deck: C.seededShuffle(songsFor(bank), G.seed) };
  }
  return deckCache.deck;
}
const songAt = i => deck()[i % deck().length];
const currentSong = () => (G && G.deckIdx != null ? songAt(G.deckIdx) : null);

const playerList = () => vals(G && G.players).sort((a, b) => a.order - b.order);
const player = id => (G && G.players && G.players[id]) || null;
const cardIds = p => vals(p && p.cards);
const cardsOf = p => cardIds(p).map(id => BY_ID.get(id)).filter(Boolean);
const placedCount = p => Math.max(0, cardIds(p).length - 1);
/** Whose board is on screen: the player taking their turn. */
const focusPlayer = () => player(G && G.turn) || player(myId);

/** Answers this room has agreed to accept, plus this device's own. */
function aliasFor(songId) {
  const mine = C.aliasesFor(aliases, songId);
  const shared = (G && G.aliases && G.aliases[songId]) || {};
  return { t: mine.t.concat(vals(shared.t)), a: mine.a.concat(vals(shared.a)) };
}

/* ──────────────────── changing the game ────────────────────
   Solo edits the object in place. Multiplayer runs the same function
   inside a transaction, so two devices acting at once cannot clobber
   each other and every device gets the result through onValue. */
async function mutate(fn) {
  if (multiplayer()) {
    await room.transact(cur => { const out = fn(cur); return out === undefined ? cur : out; });
  } else {
    fn(G);
    render();
  }
}

/* ─────────────────────────── screens ─────────────────────────── */
const SCREENS = ["screen-mode", "screen-join", "screen-rejoin", "screen-lobby",
                 "screen-setup", "screen-game"];
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  $("stats").hidden = id !== "screen-game";
  $("room-pill").hidden = !multiplayer();
  $("btn-restart").textContent = multiplayer() ? "Leave" : "New game";
  const preGame = ["screen-mode", "screen-join", "screen-rejoin"].includes(id);
  $("btn-restart").hidden = preGame;
  $("btn-settings").hidden = preGame;
}

/* ═══════════════════════════ SOLO ═══════════════════════════ */
function soloSetup() {
  room = null; myId = "solo"; G = null;
  resetDealStage();
  fillBankSelect($("opt-bank-solo"));
  $("btn-start").disabled = !BANKS.length;
  show("screen-setup");
}

function resetDealStage() {
  const stage = $("deal-stage");
  stage.innerHTML = "";
  const ph = el("div", "deal-placeholder");
  ph.appendChild(el("span", "deal-note", "?"));
  stage.appendChild(ph);
}

function startSolo() {
  const seed = C.newSeed();
  G = {
    phase: "playing", seed, hostId: "solo", turn: "solo", round: 1,
    settings: { target: intOr($("opt-target-solo").value, 10),
                naming: $("opt-naming-solo").value === "on",
                bank: bankOr($("opt-bank-solo").value).id },
    players: { solo: { id: "solo", name: "You", order: 0, cards: [], tokens: 0,
                       nameHits: 0, rounds: 0, streak: 0, best: 0, online: true } },
    deckIdx: 0, pick: null, result: null, aliases: {},
  };
  P.bank = G.settings.bank;
  savePrefs();
  const first = deck()[0];
  G.players.solo.cards = [first.id];
  G.deckIdx = 1;
  endShownFor = null;

  $("btn-start").disabled = true;
  dealAnimation(first, () => setTimeout(() => {
    $("btn-start").disabled = false;
    show("screen-game");
    render();
  }, 1250));
}

function dealAnimation(song, done) {
  const stage = $("deal-stage");
  stage.innerHTML = "";
  const ph = el("div", "deal-placeholder dealing");
  ph.appendChild(el("span", "deal-note", "♪"));
  stage.appendChild(ph);
  setTimeout(() => {
    stage.innerHTML = "";
    const card = cardNode(song, true, false);
    card.classList.add("fresh");
    stage.appendChild(card);
    done && done();
  }, 620);
}

/* ═══════════════════════ MULTIPLAYER ═══════════════════════ */
async function needNet() {
  // window.__NET__ lets the test harness swap in a local transport so the
  // multiplayer logic can be exercised without a Firebase project.
  if (window.__NET__) return (net = window.__NET__);
  if (!net) net = await import("./net.js");
  return net;
}

function joinError(msg) {
  const e = $("join-error");
  e.hidden = !msg;
  e.textContent = msg || "";
}

async function createRoom() {
  const name = $("in-name").value.trim();
  if (!name) return joinError("Put a name in first.");
  joinError("");
  setBusy(true);
  try {
    const n = await needNet();
    myId = n.makePlayerId(); myName = name;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = n.makeCode(4);
      const r = new n.Room(code, myId);
      try {
        await r.create(name, { target: 10, naming: true,
                               bank: bankOr(P.bank).id, seed: C.newSeed() });
        attachRoom(r);
        return;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
  } catch (err) {
    joinError(friendly(err));
  } finally {
    setBusy(false);
  }
}

async function joinRoom() {
  const name = $("in-name").value.trim();
  const code = $("in-code").value.trim().toUpperCase();
  if (!name) return joinError("Put a name in first.");
  if (code.length < 4) return joinError("Room codes are four characters.");
  joinError("");
  setBusy(true);
  try {
    const n = await needNet();
    myId = n.makePlayerId(); myName = name;
    const r = new n.Room(code, myId);

    // Look at the room before announcing ourselves, so a game already running
    // can offer the choice of coming in fresh or taking over a dropped player.
    const state = await r.inspect();
    if (!state) throw new Error(`No room called ${code}.`);
    if (r.stale(state)) throw new Error(`Room ${code} has expired.`);

    if (state.phase === "lobby" || (state.players || {})[myId]) {
      await r.join(name);          // the lobby, or simply us reconnecting
      attachRoom(r);
      return;
    }
    pendingJoin = { room: r, state, name };
    showRejoinChoice();
  } catch (err) {
    joinError(friendly(err));
  } finally {
    setBusy(false);
  }
}

/* ───────── coming into a game that has already started ───────── */
let pendingJoin = null;
let rejoinPoll = null;

const droppedPlayers = state =>
  vals(state && state.players).filter(p => !p.online).sort((a, b) => a.order - b.order);

function rejoinError(msg) {
  const e = $("rejoin-error");
  e.hidden = !msg;
  e.textContent = msg || "";
}

function showRejoinChoice() {
  const { room: r } = pendingJoin;
  $("rejoin-code").textContent = r.code;
  $("rejoin-list-wrap").hidden = true;
  $("rejoin-choice").hidden = false;
  rejoinError("");
  paintRejoinCount();
  show("screen-rejoin");
  startRejoinPoll();
}

function paintRejoinCount() {
  const dropped = droppedPlayers(pendingJoin.state);
  $("btn-rejoin-pick").disabled = dropped.length === 0;
  $("rejoin-count").textContent = dropped.length
    ? `${dropped.length} player${dropped.length > 1 ? "s" : ""} dropped out — continue as one of them`
    : "Nobody has dropped out — waiting…";
}

/** Keep the screen live: a player who has just refreshed takes a second or two
 *  to show as offline, so poll rather than freezing a stale snapshot. */
function startRejoinPoll() {
  stopRejoinPoll();
  rejoinPoll = setInterval(async () => {
    if (!pendingJoin || $("screen-rejoin").hidden) return stopRejoinPoll();
    try {
      const fresh = await pendingJoin.room.inspect();
      if (!fresh || !pendingJoin) return;
      pendingJoin.state = fresh;
      if (fresh.phase === "lobby") {        // they went back to the lobby
        const r = pendingJoin.room;
        stopRejoinPoll(); pendingJoin = null;
        await r.join($("in-name").value.trim() || "Player");
        attachRoom(r);
        return;
      }
      if ($("rejoin-list-wrap").hidden) paintRejoinCount();
      else paintRejoinList();
    } catch (_) {}
  }, 2500);
}

function stopRejoinPoll() {
  if (rejoinPoll) { clearInterval(rejoinPoll); rejoinPoll = null; }
}

function showRejoinList() {
  paintRejoinList();
  $("rejoin-choice").hidden = true;
  $("rejoin-list-wrap").hidden = false;
  startRejoinPoll();
}

function paintRejoinList() {
  const { state } = pendingJoin;
  const stored = (() => { try { return localStorage.getItem("timeline.playerId"); } catch (_) { return null; } })();
  const ul = $("rejoin-list");
  const dropped = droppedPlayers(state);
  ul.innerHTML = "";
  for (const p of dropped) {
    const li = el("li", "lobby-player rejoin-option");
    const btn = el("button", "rejoin-btn");
    btn.type = "button";
    btn.appendChild(el("span", "lp-name", p.name + (p.id === stored ? " (you)" : "")));
    const nc = Math.max(0, vals(p.cards).length - 1), nt = p.tokens || 0;
    btn.appendChild(el("span", "lp-state",
      `${nc} card${nc === 1 ? "" : "s"} · ${nt} token${nt === 1 ? "" : "s"}`));
    btn.addEventListener("click", () => rejoinAs(p.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  $("rejoin-empty").hidden = dropped.length > 0;
}

/** Take over a player who dropped out, keeping their cards and tokens. */
async function rejoinAs(playerId) {
  const { room: r } = pendingJoin;
  rejoinError("");
  try {
    const fresh = await r.inspect();
    const p = (fresh && fresh.players && fresh.players[playerId]) || null;
    if (!p) throw new Error("That player is no longer in the game.");
    if (p.online) throw new Error(`${p.name} has already come back — pick someone else.`);
    stopRejoinPoll();
    r.setIdentity(playerId);
    myId = playerId;
    myName = p.name;
    await r.attach();
    pendingJoin = null;
    attachRoom(r, { skipLobbyScreen: true });
  } catch (err) {
    rejoinError(friendly(err));
    pendingJoin.state = await pendingJoin.room.inspect();
    showRejoinList();
  }
}

/** Come in as somebody new, mid-game: dealt a card and added to the rotation. */
async function joinAsNewPlayer() {
  const { room: r, name } = pendingJoin;
  rejoinError("");
  try {
    await r.transact(cur => {
      if (!cur) return cur;
      const players = cur.players || (cur.players = {});
      // Read the deck off the room rather than off whatever was inspected a
      // moment ago, so the card dealt comes from the deck being played.
      const songs = songsFor(cur.settings && cur.settings.bank);
      if (Object.values(players).some(
            q => (q.name || "").toLowerCase() === name.toLowerCase() && q.id !== myId)) {
        throw new Error("Someone in this room is already using that name.");
      }
      // Deal from the far end of the deck, so the song currently being played
      // and the ones queued behind it are left alone.
      const d = C.seededShuffle(songs, cur.seed);
      const held = new Set();
      for (const q of Object.values(players)) for (const id of vals(q.cards)) held.add(id);
      cur.extraDeals = (cur.extraDeals || 0) + 1;
      let card = null;
      for (let k = cur.extraDeals; k <= d.length; k++) {
        const cand = d[d.length - k];
        if (cand && !held.has(cand.id)) { card = cand; cur.extraDeals = k; break; }
      }
      const order = Math.max(-1, ...Object.values(players).map(q => q.order || 0)) + 1;
      players[myId] = {
        id: myId, name, order, ready: true,
        cards: card ? [card.id] : [], tokens: 0, nameHits: 0, rounds: 0, online: true,
      };
      return cur;
    });
    stopRejoinPoll();
    await r.attach();
    pendingJoin = null;
    attachRoom(r, { skipLobbyScreen: true });
  } catch (err) {
    rejoinError(friendly(err));
  }
}

function friendly(err) {
  const m = (err && err.message) || String(err);
  if (/not configured/i.test(m)) {
    return "Multiplayer is not set up on this copy yet — see app/firebase-config.js.";
  }
  if (/permission|PERMISSION_DENIED/i.test(m)) {
    return "The database rejected that. Check the Realtime Database rules from the README.";
  }
  if (/Failed to fetch|NetworkError|offline/i.test(m)) return "Can't reach the server — check your connection.";
  return m;
}

function setBusy(on) {
  for (const id of ["btn-create", "btn-join"]) $(id).disabled = on;
  $("btn-create").textContent = on ? "Working…" : "Start a new room";
}

function attachRoom(r, opts = {}) {
  room = r;
  $("room-pill-code").textContent = r.code;
  $("lobby-code").textContent = r.code;
  r.onChange(state => {
    if (!state) {              // room vanished
      leaveRoom("The room was closed.");
      return;
    }
    G = state;
    render();
  });
  if (!opts.skipLobbyScreen) show("screen-lobby");
}

async function leaveRoom(msg) {
  if (room) { try { await room.leave(); } catch (_) {} }
  room = null; G = null; myId = "solo";
  stopAudio();
  $("overlay").hidden = $("overlay-end").hidden = true;
  show("screen-mode");
  if (msg) joinError(msg);
}

function renderLobby() {
  const ps = playerList();
  const list = $("lobby-players");
  list.innerHTML = "";
  for (const p of ps) {
    const li = el("li", "lobby-player" + (p.id === myId ? " is-me" : ""));
    li.appendChild(el("span", "dot" + (p.online ? " on" : "")));
    li.appendChild(el("span", "lp-name", p.name + (p.id === G.hostId ? " (host)" : "")));
    li.appendChild(el("span", "lp-state" + (p.ready ? " ready" : ""), p.ready ? "ready" : "not ready"));
    list.appendChild(li);
  }

  const mine = player(myId);
  $("btn-ready").textContent = mine && mine.ready ? "Not ready" : "I'm ready";
  $("btn-ready").classList.toggle("btn-primary", !(mine && mine.ready));

  const host = isHost();
  $("lobby-settings").style.display = host ? "" : "none";
  if (host) {
    $("opt-target").value = String((G.settings && G.settings.target) ?? 10);
    $("opt-naming").value = (G.settings && G.settings.naming) === false ? "off" : "on";
    fillBankSelect($("opt-bank"), G.settings && G.settings.bank);
  }
  // everyone else is told which deck they are in for
  const lb = bankOr(G.settings && G.settings.bank);
  $("lobby-bank").hidden = host || BANKS.length < 2;
  if (!$("lobby-bank").hidden) $("lobby-bank").textContent = `Playing the ${lb.label.toLowerCase()}.`;

  const online = ps.filter(p => p.online);
  const allReady = online.length > 0 && online.every(p => p.ready);
  $("btn-begin").hidden = !host;
  $("btn-begin").disabled = !allReady || online.length < 1;
  $("lobby-note").textContent = !host
    ? (allReady ? `Waiting for ${player(G.hostId) ? player(G.hostId).name : "the host"} to begin…`
                : "Waiting for everyone to be ready…")
    : allReady ? `${online.length} player${online.length > 1 ? "s" : ""} ready — press Begin.`
               : "Everyone needs to tap “I'm ready”.";
}

async function toggleReady() {
  if (!room) return;
  const mine = player(myId);
  await room.updatePlayer(myId, { ready: !(mine && mine.ready) });
}

async function beginGame() {
  const target = intOr($("opt-target").value, 10);
  const naming = $("opt-naming").value === "on";
  const bank = bankOr($("opt-bank").value).id;
  P.bank = bank;
  savePrefs();
  await mutate(cur => {
    const ps = vals(cur.players).filter(p => p.online).sort((a, b) => a.order - b.order);
    if (!ps.length) return cur;
    const d = C.seededShuffle(songsFor(bank), cur.seed);
    ps.forEach((p, i) => {
      cur.players[p.id].order = i;
      cur.players[p.id].cards = [d[i].id];
      cur.players[p.id].tokens = 0;
      cur.players[p.id].nameHits = 0;
      cur.players[p.id].rounds = 0;
    });
    for (const p of vals(cur.players)) if (!p.online) delete cur.players[p.id];
    cur.settings = Object.assign({}, cur.settings, { target, naming, bank });
    cur.deckIdx = ps.length;
    cur.turn = ps[0].id;
    cur.round = 1;
    cur.phase = "playing";
    cur.pick = null;
    cur.result = null;
    return cur;
  });
}

/* ═════════════════════════ THE ROUND ═════════════════════════ */
function boardOf(p) { return C.sortBoard(cardsOf(p)); }

function clearAnswers() {
  $("in-title").value = "";
  $("in-artist").value = "";
}

async function chooseSlot(i) {
  if (!isMine() || G.phase !== "playing") return;
  await mutate(cur => { cur.pick = i; return cur; });
}

async function submit() {
  if (!isMine() || G.phase !== "playing" || G.pick == null) return;
  const song = currentSong();
  const titleIn = $("in-title").value.trim();
  const artistIn = $("in-artist").value.trim();
  clearAnswers();                  // don't carry a guess into the next round
  const naming = G.settings.naming !== false;
  const result = C.judge({
    song, board: boardOf(player(myId)), slot: G.pick,
    titleIn, artistIn, naming, strict: P.strict, alias: aliasFor(song.id),
  });
  result.by = myId;
  stopAudio();

  await mutate(cur => {
    if (cur.phase !== "playing") return cur;
    const p = cur.players[result.by];
    p.rounds = (p.rounds || 0) + 1;
    if (result.yearOk) {
      p.cards = cardIds(p).concat([song.id]);
      p.streak = (p.streak || 0) + 1;
      p.best = Math.max(p.best || 0, p.streak);
    } else {
      p.streak = 0;
    }
    if (result.named) p.nameHits = (p.nameHits || 0) + 1;
    if (result.tokenWon) p.tokens = (p.tokens || 0) + 1;
    cur.result = result;
    cur.phase = "revealed";
    return cur;
  });
}

async function countAsCorrect() {
  if (!G || G.phase !== "revealed") return;
  const r = G.result;
  if (!r || r.by !== myId || !C.hasNearMiss(r, G.settings.naming !== false)) return;
  const song = BY_ID.get(r.songId);

  if (r.titleIn && !r.titleOk) aliases = C.addAlias(aliases, song.id, "t", r.titleIn);
  if (r.artistIn && !r.artistOk) aliases = C.addAlias(aliases, song.id, "a", r.artistIn);

  await mutate(cur => {
    const res = cur.result;
    if (!res || res.overridden) return cur;
    const shared = (cur.aliases = cur.aliases || {});
    const e = (shared[res.songId] = shared[res.songId] || { t: [], a: [] });
    if (res.titleIn && !res.titleOk) {
      e.t = vals(e.t).concat([res.titleIn]);
      res.titleOk = true; res.overrodeTitle = true;
    }
    if (res.artistIn && !res.artistOk) {
      e.a = vals(e.a).concat([res.artistIn]);
      res.artistOk = true; res.overrodeArtist = true;
    }
    res.overridden = true;
    if (res.titleOk && res.artistOk && !res.named) {
      res.named = true;
      const p = cur.players[res.by];
      p.nameHits = (p.nameHits || 0) + 1;
      if (res.yearOk && !res.tokenWon) { p.tokens = (p.tokens || 0) + 1; res.tokenWon = true; }
    }
    return cur;
  });
}

async function nextTurn() {
  await mutate(cur => {
    if (cur.phase !== "revealed") return cur;
    const ps = vals(cur.players).filter(p => p.online !== false).sort((a, b) => a.order - b.order);
    if (!ps.length) return cur;
    const target = intOr(cur.settings && cur.settings.target, 10);
    const done = target ? ps.find(p => Math.max(0, vals(p.cards).length - 1) >= target) : null;
    cur.result = null;
    cur.pick = null;
    cur.deckIdx = (cur.deckIdx || 0) + 1;
    if (done) {
      cur.phase = "finished";
      cur.winnerId = done.id;
      return cur;
    }
    const i = ps.findIndex(p => p.id === cur.turn);
    const nextP = ps[(i + 1) % ps.length];
    cur.turn = nextP.id;
    if (i + 1 >= ps.length) cur.round = (cur.round || 1) + 1;
    cur.phase = "playing";
    return cur;
  });
}

/** Anyone may move a dropped-out player along so the game is not stuck. */
async function skipTurn() {
  await mutate(cur => {
    if (cur.phase !== "playing") return cur;
    const ps = vals(cur.players).filter(p => p.online !== false).sort((a, b) => a.order - b.order);
    if (!ps.length) return cur;
    const i = ps.findIndex(p => p.id === cur.turn);
    cur.turn = ps[(i + 1) % ps.length].id;
    cur.pick = null;
    cur.deckIdx = (cur.deckIdx || 0) + 1;
    return cur;
  });
}

/* ═══════════════════════ RENDERING ═══════════════════════ */
function render() {
  if (!G) return;
  if (G.phase === "lobby") { show("screen-lobby"); renderLobby(); return; }
  if ($("screen-game").hidden && G.phase !== "lobby") show("screen-game");

  // A card drops in on the render right after it is placed — which only
  // reads as a placement while the same timeline is still on screen, so in
  // multiplayer (where focus moves to the next player) it correctly skips.
  if (seen.phase === "revealed" && G.phase === "playing" &&
      seen.placed && seen.owner === (G.turn || null)) {
    freshId = seen.placed;
  }
  seen = {
    phase: G.phase,
    placed: (G.phase === "revealed" && G.result && G.result.yearOk) ? G.result.songId : null,
    owner: (G.phase === "revealed" && G.result) ? G.result.by : null,
  };

  renderLeaderboard();
  renderTimeline();
  renderRoundPanel();
  renderStats();

  if (G.phase === "revealed" && G.result) showReveal(G.result);
  else $("overlay").hidden = true;

  if (G.phase === "finished") showEnd();
  else { $("overlay-end").hidden = true; endShownFor = null; }

  if (G.phase === "playing") armForRound();
}

function renderStats() {
  const p = player(myId) || focusPlayer();
  $("stat-cards").textContent = p ? placedCount(p) : 0;
  $("stat-tokens").textContent = (p && p.tokens) || 0;
  $("stat-round").textContent = G.round || 0;
  $("stat-streak").textContent = (p && p.streak) || 0;
}

function renderLeaderboard() {
  const wrap = $("leaderboard-wrap");
  wrap.hidden = !multiplayer();
  if (!multiplayer()) return;
  const ol = $("leaderboard");
  ol.innerHTML = "";
  const ps = playerList().slice().sort((a, b) =>
    placedCount(b) - placedCount(a) || (b.tokens || 0) - (a.tokens || 0) ||
    a.order - b.order);
  for (const p of ps) {
    const li = el("li", "lb" + (p.id === G.turn ? " lb-turn" : "") +
                        (p.id === myId ? " lb-me" : "") + (p.online ? "" : " lb-off"));
    const nm = el("span", "lb-name", p.name);
    if (p.id === G.turn) nm.prepend(Object.assign(el("span", "lb-arrow", "▶"), {}));
    li.appendChild(nm);
    const sc = el("span", "lb-score");
    sc.appendChild(el("b", "lb-cards", String(placedCount(p))));
    sc.appendChild(el("span", "lb-sep", "·"));
    sc.appendChild(el("b", "lb-tok", String(p.tokens || 0)));
    li.appendChild(sc);
    ol.appendChild(li);
  }
}

function renderTimeline() {
  const owner = focusPlayer();
  const tl = $("timeline");
  tl.innerHTML = "";
  if (!owner) return;
  const board = boardOf(owner);
  const starterId = cardIds(owner)[0];
  const mine = isMine() && G.phase === "playing";
  tl.classList.toggle("disabled", !mine);

  $("timeline-owner").textContent = multiplayer()
    ? (owner.id === myId ? "Your timeline" : `${owner.name}'s timeline`)
    : "Your timeline";

  for (let i = 0; i <= board.length; i++) {
    const slot = el("button", "slot");
    slot.type = "button";
    slot.appendChild(el("div", "slot-inner"));
    slot.appendChild(el("span", "slot-label", C.slotLabel(board, i)));
    slot.setAttribute("aria-label", `Place song ${C.slotLabel(board, i)}`);
    if (G.pick === i) slot.classList.add("chosen");
    if (!mine) slot.classList.add("locked");
    else slot.addEventListener("click", () => chooseSlot(i));
    tl.appendChild(slot);
    if (i < board.length) {
      tl.appendChild(cardNode(board[i], board[i].id === starterId, board[i].id === freshId));
    }
  }
  freshId = null;             // the animation is on the node now; play it once
  const focus = tl.querySelector(".card.fresh") || tl.querySelector(".slot.chosen");
  if (focus) requestAnimationFrame(() => focus.scrollIntoView({ inline: "center", block: "nearest" }));
}

function cardNode(c, isStarter, fresh) {
  const n = el("div", "card" + (isStarter ? " starter" : "") + (fresh ? " fresh" : ""));
  if (isStarter) n.appendChild(el("div", "card-tag", "Dealt"));
  if (c.art) {
    const img = el("img", "card-art");
    img.src = c.art; img.alt = ""; img.loading = "lazy"; img.width = 134; img.height = 134;
    img.addEventListener("error", () => img.remove());
    n.appendChild(img);
  }
  n.appendChild(el("div", "card-year", String(c.year)));
  n.appendChild(el("div", "card-title", c.title));
  n.appendChild(el("div", "card-artist", c.artist));
  return n;
}

function renderRoundPanel() {
  const naming = G.settings.naming !== false;
  const owner = focusPlayer();
  const mine = isMine();
  const playing = G.phase === "playing";

  $("naming").hidden = !naming || !mine;
  $("in-title").disabled = $("in-artist").disabled = !mine;
  $("btn-submit").hidden = !mine;
  $("btn-submit").disabled = !playing || G.pick == null;
  $("btn-skip").hidden = !(multiplayer() && playing && !mine && owner && !owner.online);

  const st = $("slot-status");
  if (!playing) {
    st.className = "slot-status";
    st.textContent = "Revealed — see the card.";
  } else if (G.pick != null) {
    st.className = "slot-status set";
    st.innerHTML = "";
    const who = mine ? "Placing this song " : `${esc(owner.name)} is placing it `;
    st.append(who, Object.assign(el("strong"), { textContent: C.slotLabel(boardOf(owner), G.pick) }));
  } else {
    st.className = "slot-status";
    st.textContent = mine ? "Press play, then click a gap on the timeline"
                          : `Waiting for ${owner ? owner.name : "the next player"}…`;
  }

  const cards = owner ? boardOf(owner).length : 0;
  $("timeline-hint").innerHTML = !mine
    ? `It's <strong>${esc(owner ? owner.name : "")}</strong>'s turn — everyone watches.`
    : cards > 1
      ? `Pick the gap where this song belongs — <strong>${cards}</strong> cards on the board.`
      : "Listen, then choose: <strong>before</strong> or <strong>after</strong> the song you were dealt.";

  $("round-fineprint").innerHTML = multiplayer()
    ? "The clip plays on your own device — press play whenever you like."
    : "Tip: <kbd>Space</kbd> play/pause &middot; <kbd>Enter</kbd> submit";
}

/* ─────────────────────── reveal ─────────────────────── */
function verdict(cls, ico, html) {
  const li = el("li", cls);
  li.appendChild(el("span", "vd-ico", ico));
  const d = el("div"); d.innerHTML = html; li.appendChild(d);
  return li;
}

function showReveal(r) {
  const song = BY_ID.get(r.songId);
  if (!song) return;
  const who = player(r.by);
  const art = $("rv-art");
  if (song.art) { art.src = song.art; art.style.visibility = "visible"; }
  else art.style.visibility = "hidden";
  art.onerror = () => { art.style.visibility = "hidden"; };

  $("rv-who").hidden = !multiplayer();
  $("rv-who").textContent = who ? (who.id === myId ? "Your guess" : `${who.name}'s guess`) : "";
  $("rv-year").textContent = song.year;
  $("rv-title").textContent = song.title;
  $("rv-artist").textContent = song.artist;
  $("rv-album").textContent = song.album ? `from ${song.album}` : "";

  renderVerdicts(r, song, who);
  const mineTurn = r.by === myId;
  $("btn-next").hidden = multiplayer() && !mineTurn && !isHost();
  $("btn-next").textContent = "Next song";
  $("overlay").hidden = false;
  if (!$("btn-next").hidden) $("btn-next").focus();
}

function renderVerdicts(r, song, who) {
  const naming = G.settings.naming !== false;
  const board = C.sortBoard(cardsOf(player(r.by)).filter(c => c.id !== r.songId || !r.yearOk));
  const v = $("verdicts");
  v.innerHTML = "";

  v.appendChild(r.yearOk
    ? verdict("ok", "✓", `Correct spot — <strong>${esc(C.slotLabel(board, r.slot))}</strong>. Card placed.`)
    : verdict("no", "✕", `Wrong gap. ${song.year} belongs <strong>${
        vals(r.correct).map(i => esc(C.slotLabel(board, i))).join(" or ")}</strong>, not ${
        esc(C.slotLabel(board, r.slot))}. No card.`));

  if (naming) {
    v.appendChild(r.titleOk ? verdict("ok", "✓", `Title: right.${r.overrodeTitle ? " <em>(counted)</em>" : ""}`)
      : r.titleIn ? verdict("no", "✕", `Title: “${esc(r.titleIn)}”.`)
                  : verdict("skip", "–", "Title: left blank."));
    v.appendChild(r.artistOk ? verdict("ok", "✓", `Artist: right.${r.overrodeArtist ? " <em>(counted)</em>" : ""}`)
      : r.artistIn ? verdict("no", "✕", `Artist: “${esc(r.artistIn)}”.`)
                   : verdict("skip", "–", "Artist: left blank."));
    if (r.tokenWon) {
      v.appendChild(verdict("tok", "★", `<strong>Token!</strong> ${
        who ? esc(who.name) + " now has" : "You have"} ${(who && who.tokens) || 0}.`));
    } else if (r.named && !r.yearOk) {
      v.appendChild(verdict("skip", "–", "Named it, but the year was wrong — no token."));
    }
    if (r.overridden) v.appendChild(verdict("skip", "✎", "Saved — that wording counts for this song from now on."));
  }
  if (song.chartYear && song.chartYear !== song.year) {
    v.appendChild(verdict("skip", "ⓘ", `Released ${song.year}; peaked on the ${song.chartYear} year-end chart.`));
  }
  $("btn-count").hidden = !(r.by === myId && C.hasNearMiss(r, naming));
}

function showEnd() {
  if (endShownFor === G.winnerId) return;
  endShownFor = G.winnerId || "done";
  stopAudio();
  const ps = playerList().sort((a, b) =>
    placedCount(b) - placedCount(a) || (b.tokens || 0) - (a.tokens || 0));
  const win = player(G.winnerId) || ps[0];
  $("end-title").textContent = multiplayer()
    ? (win ? (win.id === myId ? "You win!" : `${win.name} wins`) : "Game over")
    : "You filled your timeline.";

  const box = $("end-stats");
  box.innerHTML = "";
  if (multiplayer()) {
    box.className = "end-stats end-table";
    for (const p of ps) {
      const row = el("div", "end-row" + (p.id === myId ? " is-me" : ""));
      row.appendChild(el("span", "er-name", p.name));
      row.appendChild(el("span", "er-val", `${placedCount(p)} cards`));
      row.appendChild(el("span", "er-val er-tok", `${p.tokens || 0} tokens`));
      box.appendChild(row);
    }
  } else {
    box.className = "end-stats";
    const p = player("solo");
    const acc = p.rounds ? Math.round((placedCount(p) / p.rounds) * 100) : 0;
    [["Cards placed", placedCount(p)], ["Tokens", p.tokens || 0],
     ["Year accuracy", acc + "%"], ["Best streak", p.best || 0],
     ["Songs named", p.nameHits || 0], ["Rounds", p.rounds || 0]].forEach(([lab, val]) => {
      const d = el("div", "end-stat");
      d.appendChild(el("b", null, String(val)));
      d.appendChild(el("span", null, lab));
      box.appendChild(d);
    });
  }
  $("btn-again").textContent = multiplayer() ? (isHost() ? "Back to the lobby" : "Close") : "Play again";
  $("overlay-end").hidden = false;
  $("btn-again").focus();
}

/* ═══════════════════════ AUDIO ═══════════════════════ */
const audio = $("audio");
let clipTimer = null, srcP = null, jsonpSeq = 0;
const srcCache = new Map();

function jsonp(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const cb = "__dzcb" + (++jsonpSeq);
    const tag = document.createElement("script");
    let timer;
    const finish = fn => { clearTimeout(timer); delete window[cb]; tag.remove(); fn(); };
    timer = setTimeout(() => finish(() => reject(new Error("timed out"))), timeoutMs);
    window[cb] = data => finish(() => resolve(data));
    tag.onerror = () => finish(() => reject(new Error("network error")));
    tag.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
    document.head.appendChild(tag);
  });
}

/** iTunes URLs are stable and baked in; Deezer's are signed and expire within
 *  the hour, so those are fetched when needed — by JSONP, because the Deezer
 *  API sends no CORS header. */
function resolveSrc(song) {
  if (!song) return Promise.reject(new Error("no song"));
  if (song.preview) return Promise.resolve(song.preview);
  if (!song.dz) return Promise.reject(new Error("no audio source"));
  const hit = srcCache.get(song.id);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url);
  return jsonp("https://api.deezer.com/track/" + song.dz).then(d => {
    if (!d || !d.preview) throw new Error("no preview for this track");
    srcCache.set(song.id, { url: d.preview, until: Date.now() + 20 * 60 * 1000 });
    return d.preview;
  });
}

function armForRound() {
  if (G.deckIdx === lastDeckIdx) return;
  lastDeckIdx = G.deckIdx;
  stopAudio();
  audio.removeAttribute("src");
  audio.volume = P.volume;
  $("scrub-fill").style.width = "0%";
  $("player-label").textContent = `Round ${G.round} — press play`;
  $("player-sub").textContent = P.previewLen ? `${P.previewLen}-second clip` : "30-second preview";
  clearAnswers();
  armAudio(currentSong());
  const nxt = songAt(G.deckIdx + 1);
  if (nxt) resolveSrc(nxt).catch(() => {});
}

function armAudio(song) {
  srcP = resolveSrc(song).then(url => {
    if (currentSong() === song) { audio.src = url; audio.volume = P.volume; }
    return url;
  });
  srcP.catch(() => {});
  return srcP;
}

function stopAudio() {
  clearTimeout(clipTimer);
  audio.pause();
  try { audio.currentTime = 0; } catch (_) {}
  $("btn-play").classList.remove("playing", "loading");
}

function togglePlay() {
  if (!G || !currentSong()) return;
  if (!audio.paused) { audio.pause(); $("btn-play").classList.remove("playing"); return; }
  playFromStart(audio.currentTime > 0.05 && audio.currentTime < (P.previewLen || 30));
}

function playFromStart(resume) {
  const btn = $("btn-play");
  btn.classList.add("loading");
  const song = currentSong();
  const ready = audio.getAttribute("src") ? Promise.resolve() : (srcP || armAudio(song));
  ready.then(() => {
    if (currentSong() !== song) return;
    if (!resume) { try { audio.currentTime = 0; } catch (_) {} }
    return audio.play();
  }).then(() => {
    btn.classList.remove("loading");
    btn.classList.add("playing");
    $("player-label").textContent = `Round ${G.round} — playing…`;
    if (P.previewLen) {
      clearTimeout(clipTimer);
      clipTimer = setTimeout(() => { audio.pause(); btn.classList.remove("playing"); },
                             Math.max(300, (P.previewLen - audio.currentTime) * 1000));
    }
  }).catch(err => {
    btn.classList.remove("loading", "playing");
    $("player-label").textContent = "Could not play this clip";
    $("player-sub").textContent = "Check your connection, then press Replay — or submit to reveal it.";
    console.warn("playback failed:", err && err.message);
  });
}

audio.addEventListener("timeupdate", () => {
  const span = P.previewLen || audio.duration || 30;
  $("scrub-fill").style.width = Math.min(100, (audio.currentTime / span) * 100) + "%";
});
audio.addEventListener("ended", () => {
  $("btn-play").classList.remove("playing");
  if (G && G.phase === "playing") $("player-label").textContent = `Round ${G.round} — clip finished`;
});
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
  $("player-label").textContent = "This clip would not load";
  $("btn-play").classList.remove("loading", "playing");
});

/* ═══════════════════════ WIRING ═══════════════════════ */
$("btn-solo").addEventListener("click", soloSetup);
$("btn-multi").addEventListener("click", () => { joinError(""); show("screen-join"); $("in-name").focus(); });
$("btn-back-mode").addEventListener("click", () => show("screen-mode"));
$("btn-back-mode2").addEventListener("click", () => show("screen-mode"));
$("btn-create").addEventListener("click", createRoom);
$("btn-join").addEventListener("click", joinRoom);
$("in-code").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase(); });
$("btn-ready").addEventListener("click", () => toggleReady());
$("btn-begin").addEventListener("click", beginGame);
$("btn-leave-lobby").addEventListener("click", () => leaveRoom());
$("btn-join-new").addEventListener("click", joinAsNewPlayer);
$("btn-rejoin-pick").addEventListener("click", showRejoinList);
$("btn-rejoin-back").addEventListener("click", showRejoinChoice);
$("btn-rejoin-cancel").addEventListener("click", () => {
  stopRejoinPoll();
  pendingJoin = null;
  show("screen-join");
});
$("btn-copy-link").addEventListener("click", async () => {
  const url = location.href.split("#")[0];
  try { await navigator.clipboard.writeText(url); $("btn-copy-link").textContent = "Link copied"; }
  catch (_) { $("btn-copy-link").textContent = url; }
  setTimeout(() => { $("btn-copy-link").textContent = "Copy the link"; }, 2500);
});
for (const id of ["opt-target", "opt-naming", "opt-bank"]) {
  $(id).addEventListener("change", () => {
    // Lobby only: changing the deck once the cards are dealt would reshuffle
    // the running order underneath a game in progress.
    if (multiplayer() && isHost() && G && G.phase === "lobby") {
      room.update({ settings: { target: intOr($("opt-target").value, 10),
                                naming: $("opt-naming").value === "on",
                                bank: bankOr($("opt-bank").value).id,
                                seed: G.settings.seed } });
    }
  });
}

$("btn-start").addEventListener("click", startSolo);
$("btn-play").addEventListener("click", togglePlay);
$("btn-replay").addEventListener("click", () => playFromStart(false));
$("btn-submit").addEventListener("click", submit);
$("btn-count").addEventListener("click", countAsCorrect);
$("btn-next").addEventListener("click", nextTurn);
$("btn-skip").addEventListener("click", skipTurn);
$("btn-again").addEventListener("click", async () => {
  if (!multiplayer()) { $("overlay-end").hidden = true; soloSetup(); return; }
  if (isHost()) {
    await mutate(cur => {
      cur.phase = "lobby"; cur.result = null; cur.pick = null;
      cur.winnerId = null; cur.seed = C.newSeed();
      for (const p of vals(cur.players)) { cur.players[p.id].ready = false; }
      return cur;
    });
  } else {
    $("overlay-end").hidden = true;
  }
});
$("btn-restart").addEventListener("click", () => {
  if (multiplayer()) leaveRoom(); else { stopAudio(); G = null; show("screen-mode"); }
});
$("btn-settings").addEventListener("click", () => {
  $("opt-preview-len").value = String(P.previewLen);
  $("opt-volume").value = String(P.volume);
  $("opt-strict").value = String(P.strict);
  $("overlay-settings").hidden = false;
});
$("btn-close-settings").addEventListener("click", () => {
  $("overlay-settings").hidden = true;
  P.previewLen = intOr($("opt-preview-len").value, 0);
  P.strict = numOr($("opt-strict").value, 0.82);
  P.volume = numOr($("opt-volume").value, 0.8);
  audio.volume = P.volume;
  savePrefs();
});
$("opt-volume").addEventListener("input", e => {
  P.volume = numOr(e.target.value, 0.8); audio.volume = P.volume; savePrefs();
});

document.addEventListener("keydown", e => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (!$("overlay-settings").hidden) return;
  if (!$("overlay").hidden) {
    if ((e.key === "Enter" || e.key === " ") && !$("btn-next").hidden) { e.preventDefault(); nextTurn(); }
    if (e.key.toLowerCase() === "c" && !$("btn-count").hidden) { e.preventDefault(); countAsCorrect(); }
    return;
  }
  if (!$("overlay-end").hidden) return;
  if (!$("screen-setup").hidden) { if (e.key === "Enter") { e.preventDefault(); startSolo(); } return; }
  if (!$("screen-join").hidden) { if (e.key === "Enter") { e.preventDefault(); joinRoom(); } return; }
  if ($("screen-game").hidden) return;
  if (e.key === " " && !typing) { e.preventDefault(); togglePlay(); }
  if (e.key === "Enter" && !typing && !$("btn-submit").disabled) { e.preventDefault(); submit(); }
  if (e.key >= "1" && e.key <= "9" && !typing && isMine()) {
    const i = parseInt(e.key, 10) - 1;
    const owner = focusPlayer();
    if (owner && i <= boardOf(owner).length) chooseSlot(i);
  }
});
// Keep the disconnect handler armed on teardown; it is what marks us offline.
window.addEventListener("pagehide", () => { if (room) room.detach(); });

/* ═══════════════════════ BOOT ═══════════════════════ */
(function boot() {
  document.body.dataset.booted = "1";
  const fp = $("setup-fineprint");
  if (!BANKS.length) {
    fp.innerHTML = "<strong>No song data found.</strong> Run the build scripts in <code>build/</code>.";
    $("btn-solo").disabled = $("btn-multi").disabled = true;
  } else {
    fp.textContent = BANKS.map(b =>
        `${b.label}: ${b.songs.length} songs, ${b.min}–${b.max} (${b.years} years)`).join(". ")
      + ". Clips are 30-second previews streamed from Apple and Deezer.";
  }
  const code = new URLSearchParams(location.search).get("room");
  if (code) { show("screen-join"); $("in-code").value = code.toUpperCase(); }
  else show("screen-mode");

  if (location.search.includes("test")) {
    const hook = Object.assign({}, C, {
      aliasesFor: id => C.aliasesFor(aliases, id),
      aliases: () => aliases,
      clearAliases: () => { aliases = {}; C.saveAliases(aliases); },
      countAsCorrect, submit, nextTurn, skipTurn, chooseSlot, render, startSolo,
      hasNearMiss: r => C.hasNearMiss(r, G && G.settings.naming !== false),
      currentSong, boardOf, player, placedCount, playerList, focusPlayer,
      isMine: () => isMine(), isHost: () => isHost(), myId: () => myId,
      // force the audio for this round to be set up again from scratch
      rearm: () => { lastDeckIdx = -1; stopAudio(); audio.removeAttribute("src");
                     srcP = null; armForRound(); },
    });
    // defineProperty, not a literal getter in Object.assign — assign would
    // call the getter once and copy the value instead of the accessor.
    Object.defineProperty(hook, "G", { get: () => G, set: v => { G = v; } });
    Object.defineProperty(hook, "S", { get() {
      const p = player(myId) || focusPlayer();
      return {
        get cards() { return cardsOf(p); },
        get current() { return currentSong(); },
        get tokens() { return (p && p.tokens) || 0; },
        get nameHits() { return (p && p.nameHits) || 0; },
        get streak() { return (p && p.streak) || 0; },
        get round() { return G && G.round; },
        get strict() { return P.strict; }, set strict(v) { P.strict = v; },
      };
    } });
    window.__RULES__ = hook;
  }
})();
