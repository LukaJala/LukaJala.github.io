/*
 * PIXEL ALCHEMY — simulation engine
 * A falling-sand cellular automaton with 18 interacting elements.
 *
 * Pure logic, no DOM: the same file powers the browser app, the headless
 * test suite, and the screenshot renderer. Deterministic under a seeded RNG.
 */
(function (global) {
'use strict';

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const E = Object.freeze({
  EMPTY: 0, WALL: 1, STONE: 2, SAND: 3, WATER: 4, OIL: 5, ACID: 6, LAVA: 7,
  FIRE: 8, SMOKE: 9, STEAM: 10, WOOD: 11, PLANT: 12, ICE: 13, GUNPOWDER: 14,
  GLASS: 15, SPOUT: 16, VOID: 17,
});
const N = 18;

// UI metadata (the renderer uses its own fast palette below).
const ELEMENTS = [
  { id: E.EMPTY,     name: 'Eraser',    color: [26, 30, 40],    desc: 'Empty space. Right-click always erases.' },
  { id: E.WALL,      name: 'Wall',      color: [64, 66, 76],    desc: 'Indestructible. Shrugs off acid, lava, even explosions.' },
  { id: E.STONE,     name: 'Stone',     color: [132, 134, 142], desc: 'Solid rock. Forged where lava meets water; acid eats it.' },
  { id: E.SAND,      name: 'Sand',      color: [216, 184, 99],  desc: 'Falls and piles. Lava fuses it into glass.' },
  { id: E.WATER,     name: 'Water',     color: [56, 118, 210],  desc: 'Flows, levels, quenches. Boils to steam near heat.' },
  { id: E.OIL,       name: 'Oil',       color: [110, 86, 58],   desc: 'Floats on water. Burns ferociously.' },
  { id: E.ACID,      name: 'Acid',      color: [111, 226, 62],  desc: 'Dissolves almost anything. Glass and wall resist.' },
  { id: E.LAVA,      name: 'Lava',      color: [245, 90, 24],   desc: 'Molten rock. Ignites, melts, turns water to stone.' },
  { id: E.FIRE,      name: 'Fire',      color: [255, 160, 40],  desc: 'Hungry and short-lived. Spread it wisely.' },
  { id: E.SMOKE,     name: 'Smoke',     color: [68, 70, 78],    desc: 'Rises and fades away.' },
  { id: E.STEAM,     name: 'Steam',     color: [198, 210, 220], desc: 'Rises, cools, and rains back down.' },
  { id: E.WOOD,      name: 'Wood',      color: [116, 80, 48],   desc: 'Sturdy fuel. Burns slow and hot.' },
  { id: E.PLANT,     name: 'Plant',     color: [56, 161, 74],   desc: 'Alive. Drinks water to grow.' },
  { id: E.ICE,       name: 'Ice',       color: [170, 214, 240], desc: 'Creeps across still water. Melts near heat.' },
  { id: E.GUNPOWDER, name: 'Gunpowder', color: [86, 82, 94],    desc: 'Do not introduce to fire. (Introduce it to fire.)' },
  { id: E.GLASS,     name: 'Glass',     color: [184, 222, 233], desc: 'Fragile, acid-proof, born of sand and lava.' },
  { id: E.SPOUT,     name: 'Spout',     color: [60, 150, 255],  desc: 'An endless spring. Weeps fresh water.' },
  { id: E.VOID,      name: 'Void',      color: [60, 24, 88],    desc: 'Hungers. Devours whatever touches it.' },
];

// Behavior tables, indexed by element id.
const DENS = new Float32Array(N);
DENS[E.STEAM] = 0.05; DENS[E.SMOKE] = 0.10; DENS[E.FIRE] = 0.15;
DENS[E.OIL] = 0.80; DENS[E.WATER] = 1.00; DENS[E.ACID] = 1.05; DENS[E.LAVA] = 3.0;
DENS[E.GUNPOWDER] = 1.6; DENS[E.SAND] = 2.0;
DENS[E.WALL] = DENS[E.STONE] = DENS[E.WOOD] = DENS[E.PLANT] = DENS[E.ICE] =
  DENS[E.GLASS] = DENS[E.SPOUT] = DENS[E.VOID] = 9.0;

const IS_LIQUID = new Uint8Array(N); [E.WATER, E.OIL, E.ACID, E.LAVA].forEach(i => IS_LIQUID[i] = 1);
const IS_GAS    = new Uint8Array(N); [E.SMOKE, E.STEAM, E.FIRE].forEach(i => IS_GAS[i] = 1);
const IS_POWDER = new Uint8Array(N); [E.SAND, E.GUNPOWDER].forEach(i => IS_POWDER[i] = 1);
const IS_STATIC = new Uint8Array(N);
[E.WALL, E.STONE, E.WOOD, E.PLANT, E.ICE, E.GLASS, E.SPOUT, E.VOID].forEach(i => IS_STATIC[i] = 1);

const DISPERSION = new Uint8Array(N);
DISPERSION[E.WATER] = 6; DISPERSION[E.OIL] = 4; DISPERSION[E.ACID] = 5; DISPERSION[E.LAVA] = 1;

// Chance per burning neighbor per tick that this element catches fire.
const FLAMMABLE = new Float32Array(N);
FLAMMABLE[E.WOOD] = 0.018; FLAMMABLE[E.PLANT] = 0.09; FLAMMABLE[E.OIL] = 0.28;

// What acid can dissolve.
const DISSOLVES = new Uint8Array(N);
[E.STONE, E.SAND, E.WOOD, E.PLANT, E.ICE, E.GUNPOWDER, E.OIL].forEach(i => DISSOLVES[i] = 1);

const DIRS4 = [[0, -1], [0, 1], [-1, 0], [1, 0]];
// Fire checks sides, below, above, and upper diagonals (flames lick upward).
const FIRE_DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]];

// What creatures can stand on.
const IS_SOLID = new Uint8Array(N);
[E.WALL, E.STONE, E.SAND, E.WOOD, E.PLANT, E.ICE, E.GUNPOWDER, E.GLASS, E.SPOUT]
  .forEach(i => IS_SOLID[i] = 1);

// ---------------------------------------------------------------------------
// Creatures — the WorldBox layer: tiny souls living on top of the alchemy.
// They are entities, not cells: the grid is their terrain, hazard, and food.
// ---------------------------------------------------------------------------

const C = Object.freeze({ HUMAN: 0, RABBIT: 1, BIRD: 2, FISH: 3 });
const CN = 4;

const CREATURES = [
  { id: C.HUMAN,  name: 'Villager', color: [232, 190, 150], desc: 'Wanders, flees danger, chops trees — and with 10 wood, builds a hut. Villagers near each other raise children.' },
  { id: C.RABBIT, name: 'Rabbit',   color: [236, 232, 225], desc: 'Hops about and grazes on plants. Two well-fed rabbits make a third rabbit.' },
  { id: C.BIRD,   name: 'Bird',     color: [120, 140, 200], desc: 'Rides the sky, perches in the trees, and wants nothing to do with your fires.' },
  { id: C.FISH,   name: 'Fish',     color: [235, 140, 52],  desc: 'Lives in water, dies on land. The sea quietly fills with them.' },
];

const CREATURE_CAP = [44, 30, 18, 30];        // per-type population ceiling
const ADULT_AGE    = [1500, 600, 0, 400];     // ticks until grown (and fertile)
const BREATH       = [600, 360, 70, 260];     // ticks survivable in the wrong medium
const HUT_WOOD = 10;                          // wood a villager needs to build

// creature states
const S_WANDER = 0, S_SEEK = 1, S_CHOP = 2, S_BUILD = 3, S_FLEE = 4,
      S_PERCH = 5, S_BURN = 6;

const SHIRTS = [
  [202, 74, 74], [74, 122, 212], [224, 178, 70],
  [110, 190, 96], [168, 96, 198], [216, 130, 70],
];

// Raise a hut: wood frame, pitched roof, a door on the `dir` side.
// Hut timbers carry meta bit 1 so villagers never chop their own village.
function hutAt(w, cx, baseY, dir) {
  const ok = (x, y) => {
    const id = w.get(x, y);
    return id === E.EMPTY || id === E.PLANT || IS_GAS[id] || IS_LIQUID[id];
  };
  const put = (x, y) => { if (ok(x, y)) w.set(x, y, E.WOOD, 1); };
  for (let u = 0; u <= 3; u++) { put(cx - 3, baseY - u); put(cx + 3, baseY - u); } // walls
  for (let x = cx - 3; x <= cx + 3; x++) put(x, baseY - 4);                        // ceiling
  for (let x = cx - 2; x <= cx + 2; x++) put(x, baseY - 5);                        // roof
  for (let x = cx - 1; x <= cx + 1; x++) put(x, baseY - 6);                        // ridge
  // door: carve the wall open on the facing side
  const dx = cx + 3 * (dir >= 0 ? 1 : -1);
  if (w.get(dx, baseY) === E.WOOD)     w.set(dx, baseY, E.EMPTY);
  if (w.get(dx, baseY - 1) === E.WOOD) w.set(dx, baseY - 1, E.EMPTY);
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const MAGIC = 0x50414c43; // "PALC"

class World {
  constructor(w, h, seed = 1337) {
    this.w = w; this.h = h;
    const n = w * h;
    this.cells = new Uint8Array(n);  // element id
    this.meta  = new Uint8Array(n);  // per-cell scratch: fire life, gas life, lava heat, flow bias
    this.shade = new Uint8Array(n);  // per-cell color variation, fixed at spawn
    this.flags = new Uint8Array(n);  // parity bit: has this cell acted this tick?
    this.parity = 1;
    this.tickCount = 0;
    this.rngState = (seed >>> 0) || 1;
    this.creatures = [];
    this.events = { boom: 0, boomR: 0, steam: 0, ignite: 0, chop: 0, build: 0, birth: 0, death: 0 };
    this._explosions = [];
    for (let i = 0; i < n; i++) this.shade[i] = this.rnd8();
  }

  // --- deterministic RNG (mulberry32) ---
  rand() {
    // keep rngState truncated to u32: a float accumulator silently loses
    // integer precision past 2^53, which broke snapshot determinism
    this.rngState = (this.rngState + 0x6D2B79F5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  rnd8() { return (this.rand() * 256) | 0; }
  rnd(n) { return (this.rand() * n) | 0; }
  chance(p) { return this.rand() < p; }

  // --- grid access ---
  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  // Out of bounds reads as WALL: the world is a sealed box.
  get(x, y) { return this.inBounds(x, y) ? this.cells[y * this.w + x] : E.WALL; }

  set(x, y, id, meta = 0) {
    if (!this.inBounds(x, y)) return;
    this.setI(y * this.w + x, id, meta);
  }
  setI(i, id, meta = 0) {
    this.cells[i] = id;
    this.meta[i] = meta & 255;
    this.shade[i] = this.rnd8();
    this.flags[i] = this.parity;
  }
  moveI(i, j) {
    this.cells[j] = this.cells[i]; this.meta[j] = this.meta[i]; this.shade[j] = this.shade[i];
    this.flags[j] = this.parity;
    this.cells[i] = E.EMPTY; this.meta[i] = 0;
  }
  swapI(i, j) {
    const c = this.cells[i], m = this.meta[i], s = this.shade[i];
    this.cells[i] = this.cells[j]; this.meta[i] = this.meta[j]; this.shade[i] = this.shade[j];
    this.cells[j] = c; this.meta[j] = m; this.shade[j] = s;
    this.flags[i] = this.parity; this.flags[j] = this.parity;
  }

  neighborIs(x, y, id) {
    for (let d = 0; d < 4; d++) {
      if (this.get(x + DIRS4[d][0], y + DIRS4[d][1]) === id) return true;
    }
    return false;
  }
  countNeighbors4(x, y, id) {
    let c = 0;
    for (let d = 0; d < 4; d++) {
      if (this.get(x + DIRS4[d][0], y + DIRS4[d][1]) === id) c++;
    }
    return c;
  }

  // --- main step ---
  tick() {
    const { w, h, cells, flags } = this;
    this.parity ^= 1;
    const P = this.parity;
    this.tickCount++;
    const ev = this.events;
    ev.boom = 0; ev.boomR = 0; ev.steam = 0; ev.ignite = 0;
    ev.chop = 0; ev.build = 0; ev.birth = 0; ev.death = 0;

    for (let y = h - 1; y >= 0; y--) {
      const ltr = ((y ^ this.tickCount) & 1) === 0; // alternate scan direction per row
      const row = y * w;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = row + x;
        const id = cells[i];
        if (id === E.EMPTY || id === E.WALL || id === E.STONE || id === E.WOOD || id === E.GLASS) continue;
        if (flags[i] === P) continue;
        flags[i] = P;
        this.update(x, y, i, id);
      }
    }
    while (this._explosions.length) {
      const r = this._explosions.pop(), ey = this._explosions.pop(), ex = this._explosions.pop();
      this._explode(ex, ey, r);
    }
    this.updateCreatures();
  }

  update(x, y, i, id) {
    switch (id) {
      case E.SAND: case E.GUNPOWDER: this.updatePowder(x, y, i, id); break;
      case E.WATER: case E.OIL:      this.updateLiquid(x, y, i, id); break;
      case E.ACID:  this.updateAcid(x, y, i); break;
      case E.LAVA:  this.updateLava(x, y, i); break;
      case E.FIRE:  this.updateFire(x, y, i); break;
      case E.SMOKE: case E.STEAM:    this.updateGas(x, y, i, id); break;
      case E.PLANT: this.updatePlant(x, y, i); break;
      case E.ICE:   this.updateIce(x, y, i); break;
      case E.SPOUT: this.updateSpout(x, y, i); break;
      case E.VOID:  this.updateVoid(x, y, i); break;
    }
  }

  // --- movement behaviors ---

  updatePowder(x, y, i, id) {
    if (y + 1 < this.h) {
      const b = i + this.w;
      const tb = this.cells[b];
      if (tb === E.EMPTY) { this.moveI(i, b); return; }
      if ((IS_LIQUID[tb] || IS_GAS[tb]) && DENS[tb] < DENS[id] &&
          this.chance(IS_GAS[tb] ? 0.95 : 0.3)) { this.swapI(i, b); return; }
      // diagonals
      const dir = this.chance(0.5) ? 1 : -1;
      for (let s = 0; s < 2; s++) {
        const dx = s === 0 ? dir : -dir;
        const nx = x + dx;
        if (nx < 0 || nx >= this.w) continue;
        const j = b + dx;
        const tj = this.cells[j];
        if (tj === E.EMPTY) { this.moveI(i, j); return; }
        if (IS_LIQUID[tj] && DENS[tj] < DENS[id] && this.chance(0.12)) { this.swapI(i, j); return; }
      }
    }
  }

  updateLiquid(x, y, i, id) {
    if (y + 1 < this.h) {
      const b = i + this.w;
      const tb = this.cells[b];
      if (tb === E.EMPTY) { this.moveI(i, b); return; }
      if (IS_GAS[tb] && this.chance(0.55)) { this.swapI(i, b); return; }
      if (IS_LIQUID[tb] && DENS[tb] + 0.05 < DENS[id] && this.chance(0.3)) { this.swapI(i, b); return; }
      // diagonals down
      const dir = this.chance(0.5) ? 1 : -1;
      for (let s = 0; s < 2; s++) {
        const dx = s === 0 ? dir : -dir;
        const nx = x + dx;
        if (nx < 0 || nx >= this.w) continue;
        const j = b + dx;
        if (this.cells[j] === E.EMPTY) { this.moveI(i, j); return; }
      }
    }
    // lateral flow
    if (id === E.LAVA && !this.chance(0.55)) return;
    const disp = DISPERSION[id];
    let dir = (id === E.LAVA) ? (this.chance(0.5) ? 1 : -1)
                              : ((this.meta[i] & 1) ? 1 : -1);
    if (!this.flow(x, y, i, dir, disp)) {
      if (this.flow(x, y, i, -dir, disp)) dir = -dir;
      else return;
    }
  }

  // Slide horizontally up to `disp` cells toward dir; returns true if moved.
  flow(x, y, i, dir, disp) {
    let last = -1;
    for (let k = 1; k <= disp; k++) {
      const nx = x + dir * k;
      if (nx < 0 || nx >= this.w) break;
      if (this.cells[i - x + nx] !== E.EMPTY) break;
      last = nx;
    }
    if (last < 0) return false;
    const j = i - x + last;
    this.moveI(i, j);
    if (this.cells[j] !== E.LAVA) {
      this.meta[j] = (this.meta[j] & ~1) | (dir > 0 ? 1 : 0); // remember flow direction
    }
    return true;
  }

  updateGas(x, y, i, id) {
    if (id === E.STEAM) {
      if (this.neighborIs(x, y, E.ICE) && this.chance(0.3)) { this.setI(i, E.WATER); return; }
    }
    if (this.chance(0.6)) {
      let life = this.meta[i] - 1;
      if (life <= 0) {
        if (id === E.STEAM && this.chance(0.45)) this.setI(i, E.WATER);
        else this.setI(i, E.EMPTY);
        return;
      }
      this.meta[i] = life;
    }
    this.gasMove(x, y, i);
  }

  gasMove(x, y, i) {
    if (y > 0) {
      const u = i - this.w;
      const tu = this.cells[u];
      if (tu === E.EMPTY && this.chance(0.75)) { this.moveI(i, u); return; }
      if (IS_LIQUID[tu] && this.chance(0.25)) { this.swapI(i, u); return; } // bubble up
      const dir = this.chance(0.5) ? 1 : -1;
      for (let s = 0; s < 2; s++) {
        const dx = s === 0 ? dir : -dir;
        const nx = x + dx;
        if (nx < 0 || nx >= this.w) continue;
        if (this.cells[u + dx] === E.EMPTY && this.chance(0.5)) { this.moveI(i, u + dx); return; }
      }
    }
    // lateral drift
    if (this.chance(0.55)) {
      const dx = this.chance(0.5) ? 1 : -1;
      const nx = x + dx;
      if (nx >= 0 && nx < this.w && this.cells[i + dx] === E.EMPTY) this.moveI(i, i + dx);
    }
  }

  // --- reactive elements ---

  igniteNeighbors(x, y) {
    for (let d = 0; d < FIRE_DIRS.length; d++) {
      const nx = x + FIRE_DIRS[d][0], ny = y + FIRE_DIRS[d][1];
      if (!this.inBounds(nx, ny)) continue;
      const j = ny * this.w + nx;
      const nid = this.cells[j];
      if (nid === E.GUNPOWDER) {
        this.setI(j, E.FIRE, 20 + this.rnd(20));
        this.boomAt(nx, ny, 7 + this.rnd(5));
        this.events.ignite++;
        continue;
      }
      const f = FLAMMABLE[nid];
      if (f > 0 && this.chance(f)) {
        // Wood and plants burn in place (anchored flame, meta bit 7); oil flows while burning.
        if (nid === E.WOOD)       this.setI(j, E.FIRE, (90 + this.rnd(37)) | 0x80);
        else if (nid === E.PLANT) this.setI(j, E.FIRE, (36 + this.rnd(24)) | 0x80);
        else                      this.setI(j, E.FIRE, 46 + this.rnd(26));
        this.events.ignite++;
      }
    }
  }

  updateFire(x, y, i) {
    this.igniteNeighbors(x, y);
    if (this.neighborIs(x, y, E.WATER) && this.chance(0.7)) {
      this.setI(i, E.STEAM, 100 + this.rnd(80));
      this.events.steam++;
      return;
    }
    const m = this.meta[i];
    const anchored = m & 0x80;
    let life = (m & 0x7f) - 1;
    if (life <= 0) {
      if (this.chance(0.35)) this.setI(i, E.SMOKE, 30 + this.rnd(40));
      else this.setI(i, E.EMPTY);
      return;
    }
    this.meta[i] = anchored | life;
    if (anchored) {
      // A burning solid: stays put, throws flames upward.
      if (y > 0 && this.cells[i - this.w] === E.EMPTY && this.chance(0.14)) {
        this.setI(i - this.w, E.FIRE, 8 + this.rnd(14));
      }
      return;
    }
    // flames cling to fuel beneath them instead of drifting off
    if (y + 1 < this.h && FLAMMABLE[this.cells[i + this.w]] > 0 && this.chance(0.7)) return;
    this.gasMove(x, y, i);
  }

  updateLava(x, y, i) {
    this.igniteNeighbors(x, y);
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
      if (!this.inBounds(nx, ny)) continue;
      const j = ny * this.w + nx;
      const nid = this.cells[j];
      if (nid === E.WATER) {
        if (this.chance(0.75)) { this.setI(j, E.STEAM, 100 + this.rnd(80)); this.events.steam++; }
        if (this.chance(0.4)) { this.setI(i, E.STONE); return; }
      } else if (nid === E.ICE) {
        if (this.chance(0.5)) this.setI(j, E.WATER);
      } else if (nid === E.SAND) {
        if (this.chance(0.025)) this.setI(j, E.GLASS);
      }
    }
    this.updateLiquid(x, y, i, E.LAVA);
  }

  updateAcid(x, y, i) {
    const d = this.rnd(4);
    const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
    if (this.inBounds(nx, ny)) {
      const j = ny * this.w + nx;
      const nid = this.cells[j];
      if (nid === E.WATER) {
        if (this.chance(0.005)) { this.setI(i, E.WATER); return; } // dilution
      } else if (DISSOLVES[nid] && this.chance(0.07)) {
        this.setI(j, this.chance(0.25) ? E.SMOKE : E.EMPTY, 30 + this.rnd(30));
        if (this.chance(0.34)) { this.setI(i, E.EMPTY); return; } // acid is consumed
      }
    }
    this.updateLiquid(x, y, i, E.ACID);
  }

  updatePlant(x, y, i) {
    if (this.countNeighbors4(x, y, E.PLANT) >= 3) return; // stay lacy, not solid
    const d = this.rnd(4);
    const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
    if (this.get(nx, ny) === E.WATER && this.chance(0.045)) {
      this.setI(ny * this.w + nx, E.PLANT); // growth consumes the water
    }
  }

  updateIce(x, y, i) {
    for (let d = 0; d < 4; d++) {
      const nid = this.get(x + DIRS4[d][0], y + DIRS4[d][1]);
      if ((nid === E.FIRE || nid === E.LAVA) && this.chance(0.3)) { this.setI(i, E.WATER); return; }
    }
    const d = this.rnd(4);
    const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
    if (this.get(nx, ny) === E.WATER && this.chance(0.0022)) {
      this.setI(ny * this.w + nx, E.ICE);
    }
  }

  updateSpout(x, y, i) {
    if (y + 1 < this.h && this.cells[i + this.w] === E.EMPTY && this.chance(0.15)) {
      this.setI(i + this.w, E.WATER);
    }
  }

  updateVoid(x, y, i) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS4[d][0], ny = y + DIRS4[d][1];
      if (!this.inBounds(nx, ny)) continue;
      const j = ny * this.w + nx;
      const nid = this.cells[j];
      if (nid !== E.EMPTY && nid !== E.WALL && nid !== E.VOID && nid !== E.SPOUT && this.chance(0.5)) {
        this.setI(j, E.EMPTY);
      }
    }
  }

  // --- creatures ---

  spawnCreature(type, x, y, age) {
    let n = 0;
    for (const c of this.creatures) if (c.type === type && !c.dead) n++;
    if (n >= CREATURE_CAP[type]) return null;
    const c = {
      type,
      x: Math.max(1, Math.min(this.w - 2, x | 0)),
      y: Math.max(1, Math.min(this.h - 2, y | 0)),
      dir: this.chance(0.5) ? 1 : -1,
      state: S_WANDER, t: 0, tx: -1, ty: -1,
      res: 0, age: age === undefined ? ADULT_AGE[type] : age,
      breath: BREATH[type], fall: 0, cool: 0,
      seed: this.rnd8(), built: 0, dead: 0,
    };
    this.creatures.push(c);
    return c;
  }

  die(c, cause) {
    if (c.dead) return;
    c.dead = 1;
    this.events.death++;
    const i = this.idx(c.x, c.y);
    if (cause === 'fire') {
      if (this.cells[i] === E.EMPTY) this.setI(i, E.FIRE, 16 + this.rnd(14));
    } else if (cause === 'acid' || cause === 'fall') {
      if (this.cells[i] === E.EMPTY) this.setI(i, E.SMOKE, 24 + this.rnd(20));
    }
    // drowned and vanished souls leave nothing behind
  }

  updateCreatures() {
    const list = this.creatures;
    if (!list.length) return;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c.dead) continue;
      c.age++;
      if (c.cool > 0) c.cool--;
      switch (c.type) {
        case C.HUMAN:  this.updHuman(c); break;
        case C.RABBIT: this.updRabbit(c); break;
        case C.BIRD:   this.updBird(c); break;
        case C.FISH:   this.updFish(c); break;
      }
    }
    if (this.tickCount % 25 === 0) this.breed();
    let w = 0;
    for (let k = 0; k < list.length; k++) if (!list[k].dead) list[w++] = list[k];
    list.length = w;
  }

  // shared survival checks: returns true if the creature is gone or burning
  vitals(c) {
    const here = this.get(c.x, c.y), head = this.get(c.x, c.y - 1);
    if (here === E.VOID || head === E.VOID) { this.die(c, 'vanish'); return true; }
    if (here === E.ACID || head === E.ACID) { this.die(c, 'acid'); return true; }
    if (here === E.FIRE || here === E.LAVA || head === E.FIRE || head === E.LAVA) {
      if (c.type === C.FISH) { this.die(c, 'fire'); return true; }
      if (c.state !== S_BURN) { c.state = S_BURN; c.t = 22 + this.rnd(16); }
    }
    if (c.type !== C.FISH) {
      // drowning: head under liquid (birds can't even wade)
      if (IS_LIQUID[head] || (c.type === C.BIRD && IS_LIQUID[here])) {
        if (--c.breath <= 0) { this.die(c, 'drown'); return true; }
      } else if (!IS_LIQUID[here]) {
        c.breath = BREATH[c.type];
      }
    }
    if (c.state === S_BURN) {
      c.t--;
      if (c.t <= 0) { this.die(c, 'fire'); return true; }
      if (this.chance(0.15)) c.dir = -c.dir;     // flailing
      if (this.chance(0.7)) this.tryStep(c, 1);
      const i = this.idx(c.x, c.y);
      if (this.cells[i] === E.EMPTY && this.chance(0.1)) this.setI(i, E.FIRE, 8 + this.rnd(10));
      this.fallAndFloat(c);
      return true;
    }
    return false;
  }

  // gravity for walkers; in liquid they bob toward the surface instead
  fallAndFloat(c) {
    const here = this.get(c.x, c.y);
    if (IS_LIQUID[here]) {
      c.fall = 0;
      if (this.chance(0.45) && !IS_SOLID[this.get(c.x, c.y - 1)]) c.y--;
      return;
    }
    const below = this.get(c.x, c.y + 1);
    if (!IS_SOLID[below] && !IS_LIQUID[below] && c.y + 1 < this.h - 1) {
      c.y++;
      if (c.fall < 250) c.fall++;
      // terminal velocity: long falls cover 2 cells per tick
      const b2 = this.get(c.x, c.y + 1);
      if (c.fall > 4 && !IS_SOLID[b2] && !IS_LIQUID[b2] && c.y + 1 < this.h - 1) c.y++;
    } else {
      if (c.fall > 16) { this.die(c, 'fall'); return; }
      c.fall = 0;
    }
  }

  // walk one cell toward c.dir, stepping up to `climb` cells; flips dir if blocked
  tryStep(c, climb) {
    const nx = c.x + c.dir;
    if (nx < 1 || nx >= this.w - 1) { c.dir = -c.dir; return false; }
    for (let u = 0; u <= climb; u++) {
      const ny = c.y - u;
      if (ny < 1) break;
      if (u > 0 && !IS_SOLID[this.get(nx, c.y - u + 1)]) break; // only climb onto something
      if (!IS_SOLID[this.get(nx, ny)] && !IS_SOLID[this.get(nx, ny - 1)]) {
        c.x = nx; c.y = ny;
        return true;
      }
    }
    c.dir = -c.dir;
    return false;
  }

  // nearest open flame / lava / acid in a box around (x, y); -1 if calm
  scanHazard(x, y, r, alsoSmoke) {
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= this.h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= this.w) continue;
        const id = this.cells[yy * this.w + xx];
        if (id === E.FIRE || id === E.LAVA || id === E.ACID ||
            (alsoSmoke && id === E.SMOKE)) return xx;
      }
    }
    return -1;
  }

  // nearest choppable wood (hut timbers carry meta bit 1 and are sacred)
  findWood(x, y, rx, ry) {
    let bx = -1, by = -1, best = 1e9;
    const x0 = Math.max(1, x - rx), x1 = Math.min(this.w - 2, x + rx);
    const y0 = Math.max(1, y - ry), y1 = Math.min(this.h - 2, y + ry);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const i = yy * this.w + xx;
        if (this.cells[i] !== E.WOOD || (this.meta[i] & 1)) continue;
        const d = Math.abs(xx - x) * 2 + Math.abs(yy - y);
        if (d < best) { best = d; bx = xx; by = yy; }
      }
    }
    return bx < 0 ? null : { x: bx, y: by };
  }

  // is (x, y) standing on a flat, open spot fit for a hut?
  flatSpot(x, y) {
    if (x < 6 || x > this.w - 7) return false;
    for (let dx = -4; dx <= 4; dx++) {
      const g = this.get(x + dx, y + 1);
      if (!IS_SOLID[g] || IS_LIQUID[this.get(x + dx, y)]) return false;
      // headroom for the frame
      for (let u = 0; u <= 6; u++) {
        const id = this.get(x + dx, y - u);
        if (IS_SOLID[id] && id !== E.PLANT) return false;
      }
    }
    // don't build on top of the neighbors
    for (let dy = -8; dy <= 2; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const i0 = this.idx(Math.max(0, Math.min(this.w - 1, x + dx)),
                            Math.max(0, Math.min(this.h - 1, y + dy)));
        if (this.cells[i0] === E.WOOD && (this.meta[i0] & 1)) return false;
      }
    }
    return true;
  }

  updHuman(c) {
    if (this.vitals(c)) return;
    this.fallAndFloat(c);
    if (c.dead) return;
    const tk = this.tickCount + c.seed;
    // danger close: drop everything and run
    if (c.state !== S_FLEE && tk % 9 === 0) {
      const hx = this.scanHazard(c.x, c.y, 8, false);
      if (hx >= 0) {
        c.state = S_FLEE; c.t = 50;
        c.dir = hx > c.x ? -1 : hx < c.x ? 1 : (this.chance(0.5) ? 1 : -1);
      }
    }
    switch (c.state) {
      case S_FLEE:
        this.tryStep(c, 2);
        if (--c.t <= 0) c.state = S_WANDER;
        break;
      case S_WANDER: {
        if (tk % 3 === 0) {
          // landlubbers: turn back at the waterline (mostly)
          if (IS_LIQUID[this.get(c.x + c.dir, c.y)] &&
              IS_LIQUID[this.get(c.x + c.dir, c.y + 1)] && this.chance(0.85)) {
            c.dir = -c.dir;
          } else {
            if (this.chance(0.03)) c.dir = -c.dir;
            this.tryStep(c, 1);
          }
        }
        const grown = c.age >= ADULT_AGE[C.HUMAN];
        if (grown && c.res >= HUT_WOOD && c.built === 0) {
          c.state = S_BUILD; c.t = 700;
        } else if (grown && c.res < HUT_WOOD && c.built === 0 &&
                   tk % 121 === 0 && this.chance(0.3)) {
          const t = this.findWood(c.x, c.y, 70, 26);
          if (t) { c.tx = t.x; c.ty = t.y; c.state = S_SEEK; c.t = 700; }
        }
        break;
      }
      case S_SEEK: {
        if (--c.t <= 0) { c.state = S_WANDER; break; }
        if (Math.abs(c.x - c.tx) <= 1 && Math.abs(c.y - c.ty) <= 4) { c.state = S_CHOP; break; }
        if (tk % 31 === 0 && this.get(c.tx, c.ty) !== E.WOOD) { c.state = S_WANDER; break; }
        if (tk % 2 === 0) {
          c.dir = c.tx > c.x ? 1 : -1;
          if (!this.tryStep(c, 2)) c.t = c.t > 10 ? c.t - 10 : 1; // blocked: lose patience
        }
        break;
      }
      case S_CHOP: {
        if (tk % 23 !== 0) break;
        let chopped = false;
        for (let dy = -4; dy <= 2 && !chopped; dy++) {
          for (let dx = -2; dx <= 2 && !chopped; dx++) {
            const xx = c.x + dx, yy = c.y + dy;
            if (!this.inBounds(xx, yy)) continue;
            const i = yy * this.w + xx;
            if (this.cells[i] === E.WOOD && !(this.meta[i] & 1)) {
              this.setI(i, E.EMPTY);
              // the trunk settles down a cell, so the whole tree gets worked
              // from the base instead of stranding timber in the sky
              for (let y2 = yy - 1; y2 >= 1; y2--) {
                const j = y2 * this.w + xx;
                if (this.cells[j] !== E.WOOD || (this.meta[j] & 1)) break;
                this.moveI(j, j + this.w);
              }
              c.res++;
              this.events.chop++;
              chopped = true;
            }
          }
        }
        if (!chopped) { c.state = c.res >= HUT_WOOD ? S_BUILD : S_WANDER; c.t = 700; }
        else if (c.res >= HUT_WOOD) { c.state = S_BUILD; c.t = 700; }
        break;
      }
      case S_BUILD: {
        if (--c.t <= 0) { c.state = S_WANDER; break; }
        if (tk % 12 === 0 && this.flatSpot(c.x, c.y)) {
          hutAt(this, c.x, c.y, c.dir);
          c.res -= HUT_WOOD;
          c.built = 1;
          c.cool = 0;
          this.events.build++;
          c.state = S_WANDER;
          break;
        }
        if (tk % 3 === 0) this.tryStep(c, 1);
        break;
      }
    }
  }

  updRabbit(c) {
    if (this.vitals(c)) return;
    this.fallAndFloat(c);
    if (c.dead) return;
    const tk = this.tickCount + c.seed;
    if (c.state !== S_FLEE && tk % 8 === 0) {
      const hx = this.scanHazard(c.x, c.y, 7, false);
      if (hx >= 0) {
        c.state = S_FLEE; c.t = 36;
        c.dir = hx > c.x ? -1 : 1;
      }
    }
    if (c.state === S_FLEE) {
      this.tryStep(c, 2);
      if (--c.t <= 0) c.state = S_WANDER;
      return;
    }
    if (tk % 2 === 0) {
      if (this.chance(0.05)) c.dir = -c.dir;
      if (this.chance(0.8)) this.tryStep(c, 2);
    }
    // graze: nibble plants beside, above, or diagonally below — never the
    // ground directly underfoot, rabbits don't dig their own pitfalls
    if (tk % 14 === 0 && c.res < 6) {
      const spots = [[1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1]];
      for (let s = 0; s < spots.length; s++) {
        const xx = c.x + spots[s][0], yy = c.y + spots[s][1];
        if (this.get(xx, yy) === E.PLANT) {
          this.set(xx, yy, E.EMPTY);
          c.res++;
          break;
        }
      }
    }
  }

  updBird(c) {
    if (this.vitals(c)) return;
    if (c.dead) return;
    const tk = this.tickCount + c.seed;
    // smoke and flame send birds wheeling away
    if (tk % 12 === 0) {
      const hx = this.scanHazard(c.x, c.y, 7, true);
      if (hx >= 0) {
        c.state = S_WANDER;
        c.tx = Math.max(2, Math.min(this.w - 3, c.x + (hx > c.x ? -50 : 50)));
        c.ty = Math.max(4, c.y - 18);
        c.t = 90;
      }
    }
    if (c.state === S_PERCH) {
      if (!IS_SOLID[this.get(c.x, c.y + 1)]) { c.state = S_WANDER; c.tx = -1; }
      else if (this.chance(0.004)) { c.state = S_WANDER; c.tx = -1; }
      return;
    }
    // pick somewhere to be
    if (c.tx < 0 || (Math.abs(c.x - c.tx) <= 2 && Math.abs(c.y - c.ty) <= 2)) {
      c.tx = Math.max(2, Math.min(this.w - 3, c.x + this.rnd(121) - 60));
      c.ty = Math.max(5, Math.min((this.h * 0.55) | 0, c.y + this.rnd(61) - 34));
    }
    const mdx = c.tx > c.x ? 1 : c.tx < c.x ? -1 : 0;
    const mdy = c.ty > c.y ? 1 : c.ty < c.y ? -1 : 0;
    if (mdx) c.dir = mdx;
    if (this.chance(0.8)) {
      const nx = c.x + mdx;
      if (!IS_SOLID[this.get(nx, c.y)] && !IS_LIQUID[this.get(nx, c.y)]) c.x = nx;
      else c.tx = -1;
    }
    if (this.chance(0.6)) {
      const ny = c.y + mdy;
      if (!IS_SOLID[this.get(c.x, ny)] && !IS_LIQUID[this.get(c.x, ny)]) c.y = ny;
      else c.tx = -1;
    }
    // settle into a tree now and then
    const below = this.get(c.x, c.y + 1);
    if ((below === E.PLANT || below === E.WOOD) && this.chance(0.03)) c.state = S_PERCH;
  }

  updFish(c) {
    const here = this.get(c.x, c.y);
    if (here === E.VOID) { this.die(c, 'vanish'); return; }
    if (here === E.LAVA || here === E.FIRE || here === E.ACID || here === E.OIL) {
      this.die(c, here === E.ACID ? 'acid' : 'fire'); return;
    }
    if (this.scanHazard(c.x, c.y, 2, false) >= 0 && this.tickCount % 2 === 0) {
      // boiling nearby: dart away
      c.dir = -c.dir;
    }
    if (here === E.WATER) {
      c.breath = BREATH[C.FISH];
      const tk = this.tickCount + c.seed;
      if (tk % 2 !== 0) return;
      if (this.chance(0.04)) c.dir = -c.dir;
      const dy = this.chance(0.25) ? (this.chance(0.5) ? 1 : -1) : 0;
      const nx = c.x + (this.chance(0.85) ? c.dir : 0);
      if (this.get(nx, c.y + dy) === E.WATER) { c.x = nx; c.y += dy; }
      else if (this.get(c.x, c.y + dy) === E.WATER) c.y += dy;
      else c.dir = -c.dir;
      return;
    }
    // a fish out of water: flop, gasp, expire
    this.fallAndFloat(c);
    if (c.dead) return;
    if (this.chance(0.2)) c.x += this.chance(0.5) ? 1 : -1;
    c.x = Math.max(1, Math.min(this.w - 2, c.x));
    if (--c.breath <= 0) this.die(c, 'drown');
  }

  // matchmaking pass: nearby pairs of grown, rested creatures make new ones
  breed() {
    const list = this.creatures;
    const tryType = (type, dist, need, p, cool) => {
      let n = 0;
      for (const c of list) if (c.type === type && !c.dead) n++;
      if (n === 0 || n >= CREATURE_CAP[type]) return;
      for (let a = 0; a < list.length; a++) {
        const ca = list[a];
        if (ca.dead || ca.type !== type || ca.cool > 0 ||
            ca.age < ADULT_AGE[type] || ca.res < need) continue;
        for (let b = a + 1; b < list.length; b++) {
          const cb = list[b];
          if (cb.dead || cb.type !== type || cb.cool > 0 ||
              cb.age < ADULT_AGE[type] || cb.res < need) continue;
          if (Math.abs(ca.x - cb.x) > dist || Math.abs(ca.y - cb.y) > dist) continue;
          if (!this.chance(p)) continue;
          const baby = this.spawnCreature(type, (ca.x + cb.x) >> 1, (ca.y + cb.y) >> 1, 0);
          if (baby) {
            ca.cool = cool; cb.cool = cool;
            ca.res -= need; cb.res -= need;
            this.events.birth++;
          }
          return; // one birth per pass per species: villages, not plagues
        }
      }
    };
    tryType(C.HUMAN, 6, 0, 0.22, 1500);
    tryType(C.RABBIT, 5, 2, 0.35, 420);
    tryType(C.FISH, 4, 0, 0.06, 900);
  }

  // --- explosions ---

  boomAt(x, y, r) { this._explosions.push(x, y, r); }

  _explode(cx, cy, r) {
    const ev = this.events;
    ev.boom++; if (r > ev.boomR) ev.boomR = r;
    const r2 = r * r;
    for (const c of this.creatures) {
      if (c.dead) continue;
      const dx = c.x - cx, dy = c.y - cy;
      if (dx * dx + dy * dy <= r2 + 2 * r) this.die(c, 'fire');
    }
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= this.h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= this.w) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const i = yy * this.w + xx;
        const id = this.cells[i];
        const t = d2 / r2; // 0 at center, 1 at rim
        if (id === E.WALL) continue;
        if (id === E.GUNPOWDER) {
          this.setI(i, E.FIRE, 20 + this.rnd(20));
          this.boomAt(xx, yy, 6 + this.rnd(5)); // chain reaction
          continue;
        }
        if (id === E.GLASS) { if (this.chance(0.9 - t * 0.5)) this.setI(i, E.SAND); continue; }
        if (id === E.STONE) {
          if (this.chance((1 - t) * 0.65)) this.setI(i, this.chance(0.5) ? E.SAND : E.EMPTY);
          continue;
        }
        if (id === E.WATER) {
          if (this.chance((1 - t) * 0.8)) { this.setI(i, E.STEAM, 100 + this.rnd(80)); ev.steam++; }
          continue;
        }
        if (id === E.WOOD || id === E.PLANT) {
          this.setI(i, E.FIRE, ((id === E.WOOD ? 90 : 40) + this.rnd(37)) | 0x80);
          continue;
        }
        if (id === E.OIL) { this.setI(i, E.FIRE, 40 + this.rnd(30)); continue; }
        if (id === E.EMPTY) {
          if (t < 0.55) { if (this.chance(0.8)) this.setI(i, E.FIRE, 14 + this.rnd(16)); }
          else if (this.chance(0.25)) this.setI(i, E.SMOKE, 40 + this.rnd(50));
          continue;
        }
        if (id === E.ICE) { if (this.chance(0.8)) this.setI(i, E.WATER); continue; }
        if (t < 0.35 && this.chance(0.7)) this.setI(i, E.FIRE, 12 + this.rnd(12));
      }
    }
  }

  // --- painting ---

  paint(cx, cy, r, id) {
    const r2 = r * r;
    if (id === E.EMPTY) {
      // the eraser unmakes creatures too, quietly
      for (const c of this.creatures) {
        const dx = c.x - cx, dy = c.y - cy;
        if (dx * dx + dy * dy <= r2) c.dead = 1;
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= this.w) continue;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * this.w + x;
        const cur = this.cells[i];
        if (id === E.EMPTY) { if (cur !== E.EMPTY) this.setI(i, E.EMPTY); continue; }
        let fill;
        if (IS_STATIC[id]) {
          // building materials replace loose matter, never other solids
          if (!(cur === E.EMPTY || IS_LIQUID[cur] || IS_GAS[cur] || IS_POWDER[cur])) continue;
          fill = 1;
        } else {
          if (!(cur === E.EMPTY || cur === E.SMOKE || cur === E.STEAM)) continue;
          fill = IS_POWDER[id] ? 0.7 : IS_LIQUID[id] ? 0.8 : 0.55;
        }
        if (fill < 1 && !this.chance(fill)) continue;
        let meta = 0;
        if (id === E.FIRE) meta = 30 + this.rnd(40);
        else if (id === E.SMOKE) meta = 50 + this.rnd(40);
        else if (id === E.STEAM) meta = 120 + this.rnd(80);
        else if (id === E.LAVA) meta = 160 + this.rnd(80);
        this.setI(i, id, meta);
      }
    }
  }

  // --- stats / persistence ---

  stats() {
    const out = new Uint32Array(N);
    const c = this.cells;
    for (let i = 0; i < c.length; i++) out[c[i]]++;
    return out;
  }

  serialize() {
    const n = this.w * this.h;
    const cs = this.creatures;
    const CREC = 24;
    const buf = new Uint8Array(24 + n * 4 + 4 + cs.length * CREC);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, MAGIC); dv.setUint32(4, this.w); dv.setUint32(8, this.h);
    dv.setUint32(12, this.tickCount); dv.setUint32(16, this.rngState);
    dv.setUint32(20, this.parity);
    buf.set(this.cells, 24);
    buf.set(this.meta, 24 + n);
    buf.set(this.shade, 24 + n * 2);
    buf.set(this.flags, 24 + n * 3);
    let o = 24 + n * 4;
    dv.setUint32(o, cs.length); o += 4;
    for (const c of cs) {
      dv.setUint8(o, c.type); dv.setUint8(o + 1, c.dir + 1); dv.setUint8(o + 2, c.state);
      dv.setUint8(o + 3, c.res); dv.setUint8(o + 4, c.fall); dv.setUint8(o + 5, c.seed);
      dv.setUint8(o + 6, c.built); dv.setUint8(o + 7, c.dead);
      dv.setUint16(o + 8, c.x); dv.setUint16(o + 10, c.y);
      dv.setUint16(o + 12, c.t); dv.setUint16(o + 14, c.tx + 1); dv.setUint16(o + 16, c.ty + 1);
      dv.setUint16(o + 18, Math.min(65535, c.age));
      dv.setUint16(o + 20, c.breath); dv.setUint16(o + 22, c.cool);
      o += CREC;
    }
    return buf;
  }

  load(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0) !== MAGIC || dv.getUint32(4) !== this.w || dv.getUint32(8) !== this.h) {
      throw new Error('snapshot does not match this world');
    }
    const n = this.w * this.h;
    this.tickCount = dv.getUint32(12); this.rngState = dv.getUint32(16);
    this.parity = dv.getUint32(20);
    this.cells.set(buf.subarray(24, 24 + n));
    this.meta.set(buf.subarray(24 + n, 24 + n * 2));
    this.shade.set(buf.subarray(24 + n * 2, 24 + n * 3));
    this.flags.set(buf.subarray(24 + n * 3, 24 + n * 4));
    this.creatures = [];
    let o = 24 + n * 4;
    if (buf.byteLength >= o + 4) {
      const count = dv.getUint32(o); o += 4;
      for (let k = 0; k < count; k++) {
        this.creatures.push({
          type: dv.getUint8(o), dir: dv.getUint8(o + 1) - 1, state: dv.getUint8(o + 2),
          res: dv.getUint8(o + 3), fall: dv.getUint8(o + 4), seed: dv.getUint8(o + 5),
          built: dv.getUint8(o + 6), dead: dv.getUint8(o + 7),
          x: dv.getUint16(o + 8), y: dv.getUint16(o + 10),
          t: dv.getUint16(o + 12), tx: dv.getUint16(o + 14) - 1, ty: dv.getUint16(o + 16) - 1,
          age: dv.getUint16(o + 18), breath: dv.getUint16(o + 20), cool: dv.getUint16(o + 22),
        });
        o += 24;
      }
    }
  }
}

function hashState(world) {
  let h = 0x811c9dc5;
  const mix = (v) => { h ^= v; h = Math.imul(h, 0x01000193); };
  const c = world.cells, m = world.meta;
  for (let i = 0; i < c.length; i++) { mix(c[i]); mix(m[i]); }
  mix(world.creatures.length & 255);
  for (const cr of world.creatures) {
    mix(cr.type); mix(cr.x & 255); mix(cr.x >>> 8); mix(cr.y & 255); mix(cr.y >>> 8);
    mix(cr.state); mix(cr.res & 255); mix(cr.age & 255); mix(cr.dir + 1);
  }
  mix(world.rngState & 255); mix((world.rngState >>> 8) & 255);
  mix((world.rngState >>> 16) & 255); mix((world.rngState >>> 24) & 255);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Rendering (shared by browser and the headless screenshot tool)
// Writes 32-bit ABGR pixels (little-endian RGBA bytes) into buf32.
// ---------------------------------------------------------------------------

const GLOW_SHIFT = 2; // glow buffer is 1/4 resolution

const SIN = new Float32Array(256);
for (let i = 0; i < 256; i++) SIN[i] = Math.sin((i / 256) * Math.PI * 2);

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function pack(r, g, b) { return (255 << 24) | (clamp8(b) << 16) | (clamp8(g) << 8) | clamp8(r); }

function render(world, buf, at, glow) {
  const { w, h, cells, meta, shade } = world;
  const gw = glow ? (w >> GLOW_SHIFT) + 1 : 0;
  if (glow) glow.fill(0);
  let i = 0;
  for (let y = 0; y < h; y++) {
    // background: dusk sky fading to deep dark
    const ty = y / h;
    const bgR = 16 - ty * 13, bgG = 20 - ty * 16, bgB = 35 - ty * 28;
    for (let x = 0; x < w; x++, i++) {
      const id = cells[i];
      const v = shade[i];
      const j = v - 128;
      let r, g, b, emit = 0;
      switch (id) {
        case E.EMPTY: {
          r = bgR; g = bgG; b = bgB;
          if (v > 250 && ty < 0.45) { // stars
            const tw = 0.5 + 0.5 * SIN[(at + v * 9) & 255];
            const s = 60 * tw;
            r += s; g += s; b += s + 10;
          }
          break;
        }
        case E.WALL:  r = 64 + (j >> 5); g = 66 + (j >> 5); b = 76 + (j >> 5); break;
        case E.STONE: {
          const d = 1 - ty * 0.3; // terrain fades with depth
          r = (130 + (j >> 3)) * d; g = (132 + (j >> 3)) * d; b = (140 + (j >> 3)) * d; break;
        }
        case E.SAND: {
          const d = 1 - ty * 0.22;
          r = (216 + (j >> 3)) * d; g = (184 + (j >> 3)) * d; b = (99 + (j >> 4)) * d; break;
        }
        case E.WATER: {
          const s2 = SIN[(at * 2 + v * 3) & 255] * 9;
          const d = 1 - ty * 0.35;
          r = (30 + (j >> 5)) * d; g = (100 + s2 + (j >> 4)) * d; b = (196 + s2) * d; break;
        }
        case E.OIL:
          if (v > 236) { r = 110; g = 84; b = 128; }
          else { r = 82 + (j >> 4); g = 62 + (j >> 4); b = 44; }
          break;
        case E.ACID: {
          const p = SIN[(at * 3 + v) & 255] * 14;
          r = 96 + (j >> 3); g = 230 + p; b = 64; emit = 0.25; break;
        }
        case E.LAVA: {
          const t = meta[i] / 255;
          const f = SIN[(at * 5 + v * 2) & 255] * 16;
          r = 190 + 65 * t + f; g = 36 + 104 * t + f * 0.5; b = 8 + 22 * t; emit = 1; break;
        }
        case E.FIRE: {
          const L = meta[i] & 0x7f;
          const f = SIN[(at * 7 + v * 5) & 255] * 14;
          if (L > 60)      { r = 255; g = 226 + f * 0.5; b = 140; }
          else if (L > 32) { r = 252; g = 156 + f; b = 42; }
          else if (L > 14) { r = 226; g = 84 + f; b = 22; }
          else             { r = 150; g = 48; b = 22; }
          emit = 1; break;
        }
        case E.SMOKE: {
          const L = meta[i];
          const d = L < 20 ? (20 - L) : 0;
          r = 56 + (j >> 3) - d; g = 58 + (j >> 3) - d; b = 66 + (j >> 3) - d; break;
        }
        case E.STEAM: {
          const L = meta[i];
          const d = L < 24 ? (24 - L) * 3 : 0;
          r = 198 + (j >> 3) - d; g = 210 + (j >> 3) - d; b = 222 + (j >> 4) - d; break;
        }
        case E.WOOD:  r = 116 + (j >> 3); g = 80 + (j >> 3); b = 48 + (j >> 4); break;
        case E.PLANT: r = 52 + (j >> 4); g = 150 + (j >> 2); b = 70 + (j >> 4); break;
        case E.ICE:
          if (v > 246) { r = 240; g = 250; b = 255; }
          else { r = 168 + (j >> 4); g = 214 + (j >> 4); b = 240; }
          break;
        case E.GUNPOWDER:
          if (v > 248) { r = 112; g = 112; b = 120; }
          else { r = 54 + (j >> 4); g = 51 + (j >> 4); b = 60 + (j >> 4); }
          break;
        case E.GLASS:
          if (v > 240) { r = 225; g = 242; b = 248; }
          else { r = bgR + (185 - bgR) * 0.32; g = bgG + (224 - bgG) * 0.32; b = bgB + (234 - bgB) * 0.32; }
          break;
        case E.SPOUT: {
          const p = SIN[(at * 4) & 255] * 28;
          r = 56; g = 144 + p * 0.5; b = 235 + p * 0.3; break;
        }
        case E.VOID: {
          const p = SIN[(at * 5 + v) & 255] * 10;
          if (v > 250) { r = 120; g = 60; b = 160; }
          else { r = 26 - p; g = 14 - p; b = 40 - p; }
          break;
        }
        default: r = 255; g = 0; b = 255;
      }
      buf[i] = pack(r, g, b);
      if (glow && emit > 0) {
        const gi = (y >> GLOW_SHIFT) * gw + (x >> GLOW_SHIFT);
        const cur = glow[gi];
        const cr = cur & 255, cg = (cur >>> 8) & 255, cb = (cur >>> 16) & 255;
        const er = clamp8(r * emit), eg = clamp8(g * emit), eb = clamp8(b * emit);
        glow[gi] = (255 << 24) |
          ((eb > cb ? eb : cb) << 16) | ((eg > cg ? eg : cg) << 8) | (er > cr ? er : cr);
      }
    }
  }
  drawCreatures(world, buf, at);
}

// Tiny pixel souls, drawn over the cell layer. (x, y) is the feet cell.
function drawCreatures(world, buf, at) {
  const { w, h, creatures } = world;
  const put = (x, y, r, g, b) => {
    if (x >= 0 && y >= 0 && x < w && y < h) buf[y * w + x] = pack(r, g, b);
  };
  for (let k = 0; k < creatures.length; k++) {
    const c = creatures[k];
    if (c.dead) continue;
    const { x, y, dir, seed } = c;
    const f = ((at >> 2) + seed) & 1; // 2-frame animation
    if (c.state === S_BURN) {
      // a soul alight: a flailing pillar of flame
      const fl = SIN[(at * 9 + seed * 7) & 255] * 30;
      for (let u = 0; u <= 2; u++) put(x, y - u, 255, 130 + fl, 30);
      put(x + (f ? dir : -dir), y - 1, 255, 200 + fl * 0.5, 60);
      continue;
    }
    switch (c.type) {
      case C.HUMAN: {
        const sh = SHIRTS[seed % 6];
        const grown = c.age >= ADULT_AGE[C.HUMAN];
        if (grown) {
          put(x, y - 4, 52, 38, 28);                 // hair
          put(x, y - 3, 232, 190, 150);              // face
          put(x, y - 2, sh[0], sh[1], sh[2]);        // shirt
          put(x, y - 1, sh[0], sh[1], sh[2]);
          put(x, y, 38, 32, 40);                     // legs
          put(x + (f ? dir : -dir), y, 38, 32, 40);  // stride
          if (c.res > 0) put(x + dir, y - 1, 124, 86, 52); // armful of wood
        } else {
          put(x, y - 2, 232, 190, 150);
          put(x, y - 1, sh[0], sh[1], sh[2]);
          put(x, y, 38, 32, 40);
        }
        break;
      }
      case C.RABBIT: {
        const fur = (seed & 1) ? [238, 234, 226] : [168, 124, 86];
        put(x - dir, y, fur[0] - 30, fur[1] - 30, fur[2] - 24);  // haunches
        put(x, y, fur[0], fur[1], fur[2]);                       // body
        put(x + dir, y, fur[0], fur[1], fur[2]);                 // head
        put(x + dir, y - 1, fur[0] - 16, fur[1] - 16, fur[2] - 12); // ear
        break;
      }
      case C.BIRD: {
        const bd = (seed & 1) ? [56, 62, 84] : [134, 46, 52];
        put(x, y, bd[0], bd[1], bd[2]);                          // body
        put(x + dir, y, 230, 170, 60);                           // beak
        const flying = c.state !== S_PERCH;
        put(x - dir, flying && f ? y - 1 : y, bd[0] + 24, bd[1] + 24, bd[2] + 24); // wing
        break;
      }
      case C.FISH: {
        const sc = (seed & 1) ? [235, 140, 52] : [176, 196, 212];
        put(x, y, sc[0], sc[1], sc[2]);                          // head
        put(x - dir, y, sc[0] - 36, sc[1] - 36, sc[2] - 30);     // body
        if (f) put(x - dir * 2, y, sc[0] - 60, sc[1] - 56, sc[2] - 44); // tail flick
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Procedural scenes
// ---------------------------------------------------------------------------

function noise1D(w, n, step, octaves) {
  const out = new Float64Array(n);
  let amp = 1, total = 0, st = step;
  for (let o = 0; o < octaves; o++) {
    const count = Math.ceil(n / st) + 2;
    const pts = new Float64Array(count);
    for (let k = 0; k < count; k++) pts[k] = w.rand();
    for (let x = 0; x < n; x++) {
      const fx = x / st;
      const k = fx | 0;
      const t = fx - k;
      const u = (1 - Math.cos(t * Math.PI)) / 2; // cosine interpolation
      out[x] += (pts[k] * (1 - u) + pts[k + 1] * u) * amp;
    }
    total += amp; amp *= 0.5; st = Math.max(4, st >> 1);
  }
  for (let x = 0; x < n; x++) out[x] /= total;
  return out;
}

function clearWorld(w) {
  w.cells.fill(E.EMPTY); w.meta.fill(0); w.flags.fill(0);
  w.tickCount = 0;
  for (let i = 0; i < w.shade.length; i++) w.shade[i] = w.rnd8();
}

function fillRect(w, x0, y0, x1, y1, id, meta = 0) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.set(x, y, id, meta);
}

function fillEllipse(w, cx, cy, rx, ry, id, meta = 0) {
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) {
        w.set(cx + dx, cy + dy, id, meta);
      }
    }
  }
}

function genVolcano(w) {
  const W = w.w, H = w.h;
  const sea = Math.round(H * 0.71);
  const cx = Math.round(W * 0.5);
  const n1 = noise1D(w, W, 48, 4);
  const n2 = noise1D(w, W, 24, 3);
  const ground = new Int16Array(W);

  for (let x = 0; x < W; x++) {
    const seabed = H * 0.87 + n2[x] * 8;
    const d = (x - cx) / (W * 0.175);
    const bump = Math.exp(-d * d);
    let gy = Math.round(seabed - bump * H * 0.56 - n1[x] * 16 * bump - n2[x] * 5);
    gy = Math.max(26, Math.min(H - 4, gy));
    ground[x] = gy;
    for (let y = gy; y < H; y++) {
      let id = E.STONE;
      const depth = y - gy;
      if (depth < 3 && gy > sea - 7) id = E.SAND;           // beaches and seafloor dusting
      else if (depth < 2 && gy > sea - 30 && gy <= sea - 7) id = E.SAND; // lower slopes
      w.set(x, y, id);
    }
  }

  // ocean
  for (let x = 0; x < W; x++) {
    for (let y = sea; y < ground[x]; y++) w.set(x, y, E.WATER);
  }

  // summit: a reinforced cone tip with a thick-walled crater
  const peakY = ground[cx];
  fillEllipse(w, cx, peakY + 4, 14, 12, E.STONE);           // cone crown
  fillRect(w, cx - 7, peakY - 12, cx + 7, peakY, E.EMPTY);  // mouth, open to the sky
  fillEllipse(w, cx, peakY + 3, 9, 7, E.EMPTY);             // bowl
  fillEllipse(w, cx, peakY + 8, 7, 4, E.LAVA, 200);         // lava pool
  fillRect(w, cx - 1, peakY + 14, cx + 1, peakY + 34, E.LAVA, 220); // conduit
  fillEllipse(w, cx, peakY + 42, 11, 7, E.LAVA, 230);       // magma chamber

  // cabin on the left flank (placed first; trees keep their distance)
  let cabinX = -999;
  for (let x = cx - 28; x > 26; x--) {
    if (ground[x] >= sea - 20 && ground[x] < sea - 8) { cabinX = x; break; }
  }
  if (cabinX > 0) {
    const bx = cabinX;
    const K = ground[bx];
    for (let x = bx - 10; x <= bx + 10; x++) {     // terrace
      for (let y = Math.min(K, ground[x]); y < Math.max(K, ground[x]); y++) {
        w.set(x, y, y >= K ? E.STONE : E.EMPTY);
      }
      for (let y = K; y < K + 4; y++) w.set(x, y, E.STONE);
      ground[x] = K;
    }
    fillRect(w, bx - 8, K - 8, bx - 8, K - 1, E.WOOD);   // walls
    fillRect(w, bx + 8, K - 8, bx + 8, K - 1, E.WOOD);
    fillRect(w, bx - 8, K - 8, bx + 8, K - 8, E.WOOD);   // ceiling
    fillRect(w, bx - 7, K - 7, bx + 7, K - 1, E.EMPTY);  // hollow interior
    fillRect(w, bx + 8, K - 5, bx + 8, K - 1, E.EMPTY);  // door
    for (let t = 0; t < 4; t++) {                        // pitched roof
      fillRect(w, bx - 9 + t * 2, K - 9 - t, bx + 9 - t * 2, K - 9 - t, E.WOOD);
    }
    // stone hearth with embers, glowing through the doorway
    fillRect(w, bx - 7, K - 4, bx - 3, K - 1, E.STONE);
    fillRect(w, bx - 6, K - 3, bx - 4, K - 1, E.EMPTY);
    w.set(bx - 5, K - 1, E.LAVA, 255);
    w.set(bx - 4, K - 1, E.LAVA, 230);
    fillRect(w, bx - 6, K - 4, bx - 4, K - 4, E.STONE);  // hearth cap: keep the cabin safe
  }

  // trees on the flanks (trunks rooted into the slope)
  const treeXs = [];
  for (const side of [-1, 1]) {
    let placed = 0;
    for (let t = 0; t < 90 && placed < 3; t++) {
      const x = cx + side * (30 + w.rnd(42));
      if (x < 4 || x > W - 5) continue;
      const gA = ground[x], gB = ground[x + 1];
      const gy = Math.min(gA, gB);
      if (gy > sea - 34 && gy < sea - 8 && Math.abs(gA - gB) < 4 &&
          Math.abs(x - cabinX) > 11 && treeXs.every(tx => Math.abs(tx - x) > 12)) {
        treeXs.push(x);
        placed++;
        const th = 8 + w.rnd(6);
        fillRect(w, x, gy - th, x + 1, Math.max(gA, gB) - 1, E.WOOD);
        fillEllipse(w, x, gy - th - 2, 5, 4, E.PLANT);
        fillEllipse(w, x + 3 - w.rnd(7), gy - th, 3, 2, E.PLANT);
      }
    }
  }

  // scrub: little plant tufts on gentler ground above the waterline
  for (let t = 0; t < 26; t++) {
    const x = 4 + w.rnd(W - 8);
    const gy = ground[x];
    if (gy < sea - 4 && gy > sea - 52 && Math.abs(ground[x - 1] - ground[x + 1]) < 4 &&
        treeXs.every(tx => Math.abs(tx - x) > 5)) {
      fillEllipse(w, x, gy - 1, 1 + w.rnd(2), 1, E.PLANT);
    }
  }
  // a few beach boulders
  for (let t = 0; t < 4; t++) {
    const x = 8 + w.rnd(W - 16);
    const gy = ground[x];
    if (gy > sea - 6 && gy < sea + 2) fillEllipse(w, x, gy - 1, 2 + w.rnd(2), 1 + w.rnd(2), E.STONE);
  }

  // mountain spring, high on the left flank: a creek runs down past the cabin
  {
    const sx = cx - 18;
    const gy = ground[sx];
    if (gy < sea - 12) {
      w.set(sx, gy - 3, E.SPOUT);
      w.set(sx - 1, gy - 3, E.SPOUT);
    }
  }

  // buried secrets: an oil pocket, a gunpowder vein, a glowing glass geode
  fillEllipse(w, cx - 92, Math.round(H * 0.935), 13, 5, E.OIL);
  {
    let vx = cx + 72, vy = Math.round(H * 0.91);
    for (let s = 0; s < 26; s++) {
      fillEllipse(w, vx, vy, 2, 2, E.GUNPOWDER);
      vx += 1 + w.rnd(2); vy += w.rnd(3) - 1;
      vy = Math.max(Math.round(H * 0.88), Math.min(H - 4, vy));
    }
  }
  {
    const gx = Math.min(W - 12, cx + 124), gy = Math.round(H * 0.94);
    fillEllipse(w, gx, gy, 7, 6, E.GLASS);
    fillEllipse(w, gx, gy, 4, 3, E.EMPTY);
    fillRect(w, gx - 2, gy + 1, gx + 2, gy + 2, E.LAVA, 240);
  }

  // icebergs drifting at the edges
  fillEllipse(w, Math.round(W * 0.07), sea - 1, 6, 3, E.ICE);
  fillEllipse(w, Math.round(W * 0.93), sea, 5, 3, E.ICE);

  // first breath: smoke over the crater, flickers on the lava
  for (let s = 0; s < 8; s++) w.set(cx - 4 + w.rnd(9), peakY - 2 - w.rnd(6), E.SMOKE, 60 + w.rnd(60));
  for (let s = 0; s < 3; s++) w.set(cx - 3 + w.rnd(7), peakY + 3, E.FIRE, 30 + w.rnd(30));

  // the island is inhabited: cabin folk, scrub rabbits, birds, and the sea's fish
  if (cabinX > 0) {
    for (let k = 0; k < 3; k++) w.spawnCreature(C.HUMAN, cabinX + 11 + k * 3, ground[cabinX] - 1);
  }
  seedWildlife(w, ground, sea, { rabbits: 3, birds: 3, fish: 5 });
}

// scatter animals across any side-view scene with a ground line and a sea
function seedWildlife(w, ground, sea, want) {
  const W = w.w, H = w.h;
  let rabbits = 0;
  for (let t = 0; t < 120 && rabbits < want.rabbits; t++) {
    const x = 8 + w.rnd(W - 16);
    if (ground[x] < sea - 8) { w.spawnCreature(C.RABBIT, x, ground[x] - 1); rabbits++; }
  }
  for (let k = 0; k < want.birds; k++) {
    w.spawnCreature(C.BIRD, 10 + w.rnd(W - 20), 14 + w.rnd((H * 0.25) | 0));
  }
  let fish = 0;
  for (let t = 0; t < 160 && fish < want.fish; t++) {
    const x = 4 + w.rnd(W - 8);
    const y = sea + 4 + w.rnd(((H - sea) * 0.5) | 0);
    if (w.get(x, y) === E.WATER) { w.spawnCreature(C.FISH, x, y); fish++; }
  }
}

function genIsland(w) {
  const W = w.w, H = w.h;
  const sea = Math.round(H * 0.66);
  const n1 = noise1D(w, W, 56, 4);
  const n2 = noise1D(w, W, 20, 3);
  const ground = new Int16Array(W);

  // an archipelago: three islands of different temperament
  // (heights are measured from the seabed, so they must out-climb the sea)
  const isles = [
    { cx: W * 0.16, rw: W * 0.085, hgt: H * 0.29 },
    { cx: W * 0.50, rw: W * 0.130, hgt: H * 0.38 },
    { cx: W * 0.84, rw: W * 0.080, hgt: H * 0.26 },
  ];
  for (let x = 0; x < W; x++) {
    const seabed = H * 0.86 + n2[x] * 9;
    let lift = 0;
    for (const I of isles) {
      const d = (x - I.cx) / I.rw;
      const b = Math.exp(-d * d) * I.hgt;
      if (b > lift) lift = b;
    }
    let gy = Math.round(seabed - lift - n1[x] * 14 * Math.min(1, lift / 18) - n2[x] * 5);
    gy = Math.max(18, Math.min(H - 4, gy));
    ground[x] = gy;
    for (let y = gy; y < H; y++) {
      let id = E.STONE;
      const depth = y - gy;
      if (gy > sea - 7) { if (depth < 3) id = E.SAND; }   // beaches and seafloor
      else if (depth < 2) id = E.PLANT;                   // a skin of grass on dry land
      w.set(x, y, id);
    }
  }
  // ocean
  for (let x = 0; x < W; x++) {
    for (let y = sea; y < ground[x]; y++) w.set(x, y, E.WATER);
  }

  // forests
  const treeXs = [];
  for (let t = 0; t < 2000 && treeXs.length < 14; t++) {
    const x = 6 + w.rnd(W - 12);
    const gA = ground[x], gB = ground[x + 1];
    const gy = Math.min(gA, gB);
    if (gy < sea - 10 && Math.abs(gA - gB) < 4 &&
        treeXs.every(tx => Math.abs(tx - x) > 9)) {
      treeXs.push(x);
      const th = 7 + w.rnd(7);
      fillRect(w, x, gy - th, x + 1, Math.max(gA, gB) - 1, E.WOOD);
      fillEllipse(w, x, gy - th - 2, 4 + w.rnd(2), 3 + w.rnd(2), E.PLANT);
      fillEllipse(w, x + 3 - w.rnd(7), gy - th + 1, 3, 2, E.PLANT);
    }
  }

  // a founding village on the great island: two huts on terraced ground
  const vcx = Math.round(isles[1].cx);
  const hutXs = [];
  let huts = 0;
  for (let off = 8; off < W * 0.22 && huts < 2; off += 3) {
    for (const s of [-1, 1]) {
      if (huts >= 2) break;
      const x = vcx + s * off;
      if (x < 10 || x > W - 11) continue;
      if (ground[x] >= sea - 10) continue;
      if (!treeXs.every(tx => Math.abs(tx - x) > 8)) continue;
      if (!hutXs.every(hx => Math.abs(hx - x) > 14)) continue;
      const K = ground[x];
      for (let xx = x - 5; xx <= x + 5; xx++) {  // terrace
        for (let y = Math.min(K, ground[xx]); y < Math.max(K, ground[xx]); y++) {
          w.set(xx, y, y >= K ? E.STONE : E.EMPTY);
        }
        for (let y = K; y < K + 3; y++) w.set(xx, y, E.STONE);
        ground[xx] = K;
      }
      hutAt(w, x, K - 1, s);
      hutXs.push(x);
      huts++;
    }
  }
  // the villagers themselves; most are settled folk, two still dream of huts
  let souls = 0;
  for (let t = 0; t < 200 && souls < 6; t++) {
    const x = vcx + w.rnd(81) - 40;
    if (x > 4 && x < W - 5 && ground[x] < sea - 8) {
      const v = w.spawnCreature(C.HUMAN, x, ground[x] - 1);
      if (v && souls >= 2) v.built = 1;
      souls++;
    }
  }

  // a freshwater spring on the great island's shoulder
  {
    const sx = vcx - Math.round(isles[1].rw * 0.55);
    if (ground[sx] < sea - 14) w.set(sx, ground[sx] - 3, E.SPOUT);
  }

  // buried temptations: oil under the west island, powder under the east
  fillEllipse(w, Math.round(isles[0].cx), Math.round(H * 0.93), 12, 4, E.OIL);
  {
    let vx = Math.round(isles[2].cx) - 12, vy = Math.round(H * 0.91);
    for (let s = 0; s < 20; s++) {
      fillEllipse(w, vx, vy, 2, 2, E.GUNPOWDER);
      vx += 1 + w.rnd(2); vy += w.rnd(3) - 1;
      vy = Math.max(Math.round(H * 0.88), Math.min(H - 4, vy));
    }
  }

  // drifting ice at the world's edges
  fillEllipse(w, Math.round(W * 0.05), sea - 1, 6, 3, E.ICE);
  fillEllipse(w, Math.round(W * 0.96), sea, 5, 3, E.ICE);

  seedWildlife(w, ground, sea, { rabbits: 6, birds: 5, fish: 10 });
}

function genSprings(w) {
  const W = w.w, H = w.h;
  const floor = H - 12;
  fillRect(w, 0, floor, W - 1, H - 1, E.STONE);

  // descending stone basins; each overlaps the next so the overflow cascades
  const basins = [
    { x0: Math.round(W * 0.06), x1: Math.round(W * 0.32), y: Math.round(H * 0.30) },
    { x0: Math.round(W * 0.28), x1: Math.round(W * 0.60), y: Math.round(H * 0.50) },
    { x0: Math.round(W * 0.56), x1: Math.round(W * 0.88), y: Math.round(H * 0.70) },
  ];
  for (let b = 0; b < basins.length; b++) {
    const { x0, x1, y } = basins[b];
    fillRect(w, x0, y, x1, y + 2, E.STONE);                 // tray floor
    fillRect(w, x0, y - 12, x0 + 2, y, E.STONE);            // tall left wall
    fillRect(w, x1 - 2, y - 4, x1, y, E.STONE);             // low right lip
    fillRect(w, x0 + 3, y - 3, x1 - 3, y - 1, E.WATER);     // starter water
    // greenery on the rim
    fillEllipse(w, x0 + 4 + w.rnd(6), y - 13, 3, 2, E.PLANT);
    fillEllipse(w, x1 - 6, y - 5, 2, 2, E.PLANT);
  }
  // the spring pours in near the first basin's lip, keeping the cascade busy
  w.set(basins[0].x1 - 9, basins[0].y - 20, E.SPOUT);
  w.set(basins[0].x1 - 8, basins[0].y - 20, E.SPOUT);

  // glass spheres on pedestals between the falls
  for (const [px, r] of [[Math.round(W * 0.50), 6], [Math.round(W * 0.16), 5]]) {
    fillRect(w, px - 1, floor - 8, px + 1, floor - 1, E.STONE);
    fillEllipse(w, px, floor - 12, r, r, E.GLASS);
    fillEllipse(w, px, floor - 12, r - 2, r - 2, E.EMPTY);
    w.set(px, floor - 12 + r - 3, E.LAVA, 245);
  }

  // a drain pocket so the springs never flood: walled, mouth up
  const dx = Math.round(W * 0.96);
  fillRect(w, dx - 2, floor - 2, dx + 2, floor - 1, E.WALL);
  w.set(dx, floor - 1, E.VOID);

  // soft sand dunes on the ground
  for (let d = 0; d < 5; d++) {
    fillEllipse(w, 20 + w.rnd(W - 40), floor - 1, 6 + w.rnd(8), 2, E.SAND);
  }
  // a resident ice block, slowly weeping
  fillEllipse(w, Math.round(W * 0.82), Math.round(H * 0.25), 5, 4, E.ICE);
  fillRect(w, Math.round(W * 0.78), Math.round(H * 0.25) + 5, Math.round(W * 0.86), Math.round(H * 0.25) + 6, E.STONE);

  // fish in the basins, birds in the rafters
  for (const b of basins) {
    const x = (b.x0 + b.x1) >> 1;
    if (w.get(x, b.y - 2) === E.WATER) w.spawnCreature(C.FISH, x, b.y - 2);
  }
  w.spawnCreature(C.BIRD, Math.round(W * 0.3), Math.round(H * 0.14));
  w.spawnCreature(C.BIRD, Math.round(W * 0.7), Math.round(H * 0.2));
}

function generateScene(world, name) {
  clearWorld(world);
  world.creatures.length = 0;
  if (name === 'volcano') genVolcano(world);
  else if (name === 'springs') genSprings(world);
  else if (name === 'island') genIsland(world);
  // 'blank' stays empty
}

// ---------------------------------------------------------------------------

const api = {
  E, N, ELEMENTS, World, generateScene, render, hashState, GLOW_SHIFT,
  IS_LIQUID, IS_GAS, IS_POWDER, IS_STATIC,
  C, CN, CREATURES, CREATURE_CAP, HUT_WOOD,
  VERSION: '2.0.0',
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
global.PixelAlchemy = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
