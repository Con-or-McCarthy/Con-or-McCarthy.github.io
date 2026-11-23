/* net.js — the multiplayer room, on Firebase Realtime Database.
   Loaded only when someone actually starts or joins a game, so the solo
   game keeps working with no config and no network. */

const SDK = "https://www.gstatic.com/firebasejs/11.10.0";
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;      // rooms older than this are stale

let fb = null;        // { app, db, api }

async function sdk() {
  if (fb) return fb;

  let cfgMod;
  try {
    cfgMod = await import("./firebase-config.js");
  } catch (err) {
    // The commonest cause by far: the whole Firebase console snippet was
    // pasted in, and its `import ... from "firebase/app"` cannot be resolved
    // by a browser, so the module never loads.
    const m = (err && err.message) || "";
    if (/firebase\/app|module specifier/i.test(m)) {
      throw new Error('app/firebase-config.js has an `import ... from "firebase/app"` '
        + "line in it. Delete that line and the initializeApp line, and keep only "
        + "`export const firebaseConfig = { ... }`.");
    }
    throw new Error("app/firebase-config.js could not be loaded: " + m);
  }

  // accept `export const firebaseConfig`, a default export, or `config`
  const cfg = cfgMod.firebaseConfig || cfgMod.default || cfgMod.config;
  if (!cfg || typeof cfg !== "object") {
    throw new Error("app/firebase-config.js does not export firebaseConfig — it needs "
      + "`export const firebaseConfig = { ... }`.");
  }
  if (!cfg.databaseURL) {
    throw new Error("The config has no databaseURL. In the Firebase console open "
      + "Build → Realtime Database and copy the config again — a project with only "
      + "Firestore has no databaseURL.");
  }
  if (/PASTE|YOUR_/i.test(JSON.stringify(cfg))) {
    throw new Error("Firebase is not configured yet — see app/firebase-config.js");
  }
  const [{ initializeApp }, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const app = initializeApp(cfg);
  fb = { app, db: dbMod.getDatabase(app), api: dbMod };
  return fb;
}

/* Room codes people can read out loud: no vowels, no 0/O/1/I. */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export function makeCode(n = 4) {
  const a = new Uint32Array(n);
  (crypto.getRandomValues ? crypto : { getRandomValues: x => x.forEach((_, i) => x[i] = Math.random() * 2 ** 32) })
    .getRandomValues(a);
  return Array.from(a, v => ALPHABET[v % ALPHABET.length]).join("");
}

export function makePlayerId() {
  const k = "timeline.playerId";
  try {
    let v = localStorage.getItem(k);
    if (!v) { v = makeCode(10) + Date.now().toString(36); localStorage.setItem(k, v); }
    return v;
  } catch (_) {
    return makeCode(10) + Date.now().toString(36);
  }
}

/** A live connection to one room. */
export class Room {
  constructor(code, playerId) {
    this.code = code.toUpperCase();
    this.playerId = playerId;
    this.state = null;
    this.listeners = new Set();
    this._off = null;
  }

  get path() { return `rooms/${this.code}`; }

  /** Fires immediately with the state we already hold, so a caller that
   *  subscribes after connecting never misses the first snapshot. */
  onChange(fn) {
    this.listeners.add(fn);
    if (this.state) fn(this.state);
    return () => this.listeners.delete(fn);
  }
  _emit() { for (const fn of this.listeners) fn(this.state); }

  async _ref(sub) {
    const { db, api } = await sdk();
    return api.ref(db, sub ? `${this.path}/${sub}` : this.path);
  }

  /** Create the room. Fails if the code is already taken by a live room. */
  async create(name, settings) {
    const { api } = await sdk();
    const ref = await this._ref();
    const snap = await api.get(ref);
    const cur = snap.val();
    if (cur && Date.now() - (cur.createdAt || 0) < ROOM_TTL_MS) {
      throw new Error("That room code is in use — try again.");
    }
    await api.set(ref, {
      createdAt: Date.now(),
      hostId: this.playerId,
      phase: "lobby",
      settings,
      seed: settings.seed,
      players: {
        [this.playerId]: {
          id: this.playerId, name, order: 0, ready: true,
          cards: [], tokens: 0, nameHits: 0, rounds: 0, online: true,
        },
      },
    });
    await this._attach();
  }

  /** Read the room once, without joining or announcing ourselves. */
  async inspect() {
    const { api } = await sdk();
    const snap = await api.get(await this._ref());
    return snap.val();
  }

  /** Continue as a particular player — used when rejoining a game in progress. */
  setIdentity(id) {
    this.playerId = id;
    try { localStorage.setItem("timeline.playerId", id); } catch (_) {}
  }

  /** Start watching the room as whoever we currently are. */
  async attach() { await this._attach(); }

  stale(cur) { return Date.now() - (cur.createdAt || 0) > ROOM_TTL_MS; }

  /** Join an existing room. */
  async join(name) {
    const { api } = await sdk();
    const ref = await this._ref();
    const snap = await api.get(ref);
    const cur = snap.val();
    if (!cur) throw new Error(`No room called ${this.code}.`);
    if (Date.now() - (cur.createdAt || 0) > ROOM_TTL_MS) throw new Error(`Room ${this.code} has expired.`);

    const players = cur.players || {};
    const mine = players[this.playerId];
    if (!mine && cur.phase !== "lobby") {
      throw new Error("That game has already started.");
    }
    if (!mine) {
      const taken = Object.values(players).some(
        p => (p.name || "").toLowerCase() === name.toLowerCase());
      if (taken) throw new Error("Someone in this room is already using that name.");
      const order = Object.keys(players).length;
      await api.set(await this._ref(`players/${this.playerId}`), {
        id: this.playerId, name, order, ready: false,
        cards: [], tokens: 0, nameHits: 0, rounds: 0, online: true,
      });
    } else {
      await api.update(await this._ref(`players/${this.playerId}`), { name, online: true });
    }
    await this._attach();
  }

  /** Watch the room, and mark ourselves offline if this device drops. */
  async _attach() {
    const { api } = await sdk();
    const me = await this._ref(`players/${this.playerId}/online`);
    this._onDisc = api.onDisconnect(me);
    this._onDisc.set(false);
    await api.set(me, true);

    const ref = await this._ref();
    this._off = api.onValue(ref, snap => {
      this.state = snap.val();
      this._emit();
    });
  }

  async update(patch) {
    const { api } = await sdk();
    await api.update(await this._ref(), patch);
  }

  async updatePlayer(id, patch) {
    const { api } = await sdk();
    await api.update(await this._ref(`players/${id}`), patch);
  }

  /** Run a change against the freshest copy of the room, so two devices
   *  acting at the same moment cannot overwrite each other. */
  async transact(fn) {
    const { api } = await sdk();
    const ref = await this._ref();
    const res = await api.runTransaction(ref, cur => (cur ? fn(cur) : cur));
    return res && res.snapshot ? res.snapshot.val() : null;
  }

  /** Leaving on purpose, with the page still alive: cancel the drop handler
   *  (so it cannot fire later and recreate a removed room as a stray
   *  fragment) and write the offline flag ourselves. */
  async leave() {
    try {
      const { api } = await sdk();
      if (this._onDisc) { try { await this._onDisc.cancel(); } catch (_) {} }
      await api.update(await this._ref(`players/${this.playerId}`), { online: false });
    } catch (_) {}
    this.close();
  }

  /** The page is going away (refresh, tab close, navigation). Leave the drop
   *  handler armed — it is the only thing that will reliably mark us offline,
   *  since an async write here is unlikely to finish before teardown. */
  detach() {
    if (this._off) { this._off(); this._off = null; }
    this.listeners.clear();
  }

  close() {
    if (this._off) { this._off(); this._off = null; }
    this._onDisc = null;
    this.listeners.clear();
  }
}

export const players = state =>
  Object.values((state && state.players) || {}).sort((a, b) => a.order - b.order);

export const onlinePlayers = state => players(state).filter(p => p.online);
