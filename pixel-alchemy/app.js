/* PIXEL ALCHEMY — browser shell: rendering, input, sound, UI. */
'use strict';
(() => {

const { E, ELEMENTS, World, generateScene, render, GLOW_SHIFT } = window.PixelAlchemy;

const W = 384, H = 240, SCALE = 3;
const GW = (W >> GLOW_SHIFT) + 1, GH = (H >> GLOW_SHIFT) + 1;

// --- state ---
const params = new URLSearchParams(location.search);
let scene = ['volcano', 'springs', 'blank'].includes(params.get('scene')) ? params.get('scene') : 'volcano';
let seed = (parseInt(params.get('seed'), 10) >>> 0) || ((Math.random() * 0xffffffff) >>> 0);
let world = null;
let paused = false;
let brush = 4;
let element = E.SAND;
let animTick = 0;
let muted = false;

const undoStack = [], redoStack = [];

// --- DOM ---
const $ = (id) => document.getElementById(id);
const view = $('view');
view.width = W * SCALE; view.height = H * SCALE;
const vctx = view.getContext('2d');

const simCanvas = document.createElement('canvas');
simCanvas.width = W; simCanvas.height = H;
const sctx = simCanvas.getContext('2d');
const img = new ImageData(W, H);
const buf32 = new Uint32Array(img.data.buffer);

const glowCanvas = document.createElement('canvas');
glowCanvas.width = GW; glowCanvas.height = GH;
const gctx = glowCanvas.getContext('2d');
const glowImg = new ImageData(GW, GH);
const glow32 = new Uint32Array(glowImg.data.buffer);

// engine packs little-endian RGBA; swap on the (vanishingly rare) BE platform
const LITTLE_ENDIAN = (() => {
  const b = new ArrayBuffer(4);
  new Uint32Array(b)[0] = 0x0a0b0c0d;
  return new Uint8Array(b)[0] === 0x0d;
})();
function fixEndian(arr) {
  if (LITTLE_ENDIAN) return;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    arr[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
  }
}

// --- sound: all procedural, conjured from math ---
const sfx = {
  ctx: null, master: null, noiseBuf: null, crackleGain: null, lastBlip: 0,
  ensure() {
    if (this.ctx || muted) return;
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const n = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      // looping fire-crackle bed, silent until there is fire in the world
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.8;
      this.crackleGain = this.ctx.createGain();
      this.crackleGain.gain.value = 0;
      src.connect(bp).connect(this.crackleGain).connect(this.master);
      src.start();
    } catch (e) { /* sound is a luxury, never a requirement */ }
  },
  noise(dur, type, freq, gain, slideTo) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random() * 0.5;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },
  tone(dur, shape, f0, f1, gain) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = shape;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  blip(id) {
    if (!this.ctx || muted) return;
    const now = performance.now();
    if (now - this.lastBlip < 45) return;
    this.lastBlip = now;
    if (id === E.EMPTY)            this.noise(0.05, 'lowpass', 500, 0.04);
    else if (id === E.FIRE || id === E.LAVA) this.noise(0.09, 'highpass', 900, 0.05);
    else if (id === E.WATER || id === E.OIL || id === E.ACID) this.tone(0.09, 'sine', 300, 140, 0.05);
    else if (id === E.SAND || id === E.GUNPOWDER) this.noise(0.06, 'bandpass', 1700, 0.05);
    else this.tone(0.04, 'triangle', 210, 180, 0.04);
  },
  boom(r) {
    if (!this.ctx || muted) return;
    this.noise(0.6, 'lowpass', 900, Math.min(0.55, 0.3 + r / 35), 70);
    this.tone(0.5, 'sine', 110, 34, 0.4);
  },
  hiss(a) {
    if (!this.ctx || muted) return;
    this.noise(0.25, 'highpass', 2200, 0.1 * a);
  },
  setCrackle(level) {
    if (!this.ctx || !this.crackleGain) return;
    const target = muted ? 0 : Math.min(1, level) * 0.13;
    this.crackleGain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + 0.4);
  },
};

// --- world management ---
function newWorld(newSeed) {
  seed = newSeed >>> 0;
  world = new World(W, H, seed);
  generateScene(world, scene);
  if (scene !== 'blank') for (let i = 0; i < 90; i++) world.tick();
  undoStack.length = 0; redoStack.length = 0;
  updateFooterStatic();
}

function snapshot() {
  undoStack.push(world.serialize());
  if (undoStack.length > 24) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(world.serialize());
  world.load(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(world.serialize());
  world.load(redoStack.pop());
}

// --- palette ---
const ORDER = [E.SAND, E.WATER, E.OIL, E.ACID, E.LAVA, E.FIRE, E.GUNPOWDER, E.WOOD,
  E.PLANT, E.ICE, E.STONE, E.WALL, E.GLASS, E.SPOUT, E.VOID, E.EMPTY];
const KEYS = { [E.SAND]: '1', [E.WATER]: '2', [E.OIL]: '3', [E.ACID]: '4', [E.LAVA]: '5',
  [E.FIRE]: '6', [E.GUNPOWDER]: '7', [E.WOOD]: '8', [E.PLANT]: '9', [E.ICE]: '0',
  [E.STONE]: 'Q', [E.WALL]: 'W', [E.GLASS]: 'G', [E.SPOUT]: 'O', [E.VOID]: 'V', [E.EMPTY]: 'E' };

const paletteEl = $('palette');
const infoEl = $('info');
const chips = new Map();
for (const id of ORDER) {
  const el = ELEMENTS[id];
  const btn = document.createElement('button');
  btn.className = 'chip';
  btn.innerHTML = `<span class="sw" style="background:rgb(${el.color.join(',')})"></span>` +
    `<span class="nm">${el.name}</span><span class="key">${KEYS[id]}</span>`;
  btn.addEventListener('click', () => selectElement(id));
  btn.addEventListener('mouseenter', () => showInfo(id));
  btn.addEventListener('mouseleave', () => showInfo(element));
  paletteEl.appendChild(btn);
  chips.set(id, btn);
}
function selectElement(id) {
  element = id;
  for (const [eid, btn] of chips) btn.classList.toggle('on', eid === id);
  showInfo(id);
}
function showInfo(id) {
  const el = ELEMENTS[id];
  infoEl.innerHTML = `<b>${el.name}</b>${el.desc}`;
}

// --- input on canvas ---
let painting = false, erasing = false, lastPt = null, mousePt = null;

function toSim(ev) {
  const r = view.getBoundingClientRect();
  return {
    x: Math.floor((ev.clientX - r.left) / r.width * W),
    y: Math.floor((ev.clientY - r.top) / r.height * H),
  };
}
function paintLine(a, b, id) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
  for (let s = 0; s <= steps; s++) {
    world.paint(Math.round(a.x + dx * s / steps), Math.round(a.y + dy * s / steps), brush, id);
  }
}

view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  view.setPointerCapture(e.pointerId);
  sfx.ensure();
  hideToast();
  painting = true;
  erasing = e.button === 2;
  lastPt = mousePt = toSim(e);
  snapshot();
  const id = erasing ? E.EMPTY : element;
  world.paint(lastPt.x, lastPt.y, brush, id);
  sfx.blip(id);
});
view.addEventListener('pointermove', (e) => {
  mousePt = toSim(e);
  if (!painting) return;
  const id = erasing ? E.EMPTY : element;
  paintLine(lastPt, mousePt, id);
  lastPt = mousePt;
  sfx.blip(id);
});
const endStroke = () => { painting = false; lastPt = null; };
view.addEventListener('pointerup', endStroke);
view.addEventListener('pointercancel', endStroke);
view.addEventListener('pointerleave', () => { if (!painting) mousePt = null; });
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  setBrush(brush + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// --- toolbar ---
const brushSlider = $('brush'), brushOut = $('brush-out');
function setBrush(v) {
  brush = Math.max(1, Math.min(24, v));
  brushSlider.value = brush;
  brushOut.value = brush;
}
brushSlider.addEventListener('input', () => setBrush(+brushSlider.value));
brushSlider.addEventListener('change', () => brushSlider.blur());

function setPaused(p) {
  paused = p;
  $('paused-pill').classList.toggle('show', paused);
  $('btn-pause').textContent = paused ? '▶' : '⏸';
  $('btn-pause').classList.toggle('toggled', paused);
}
$('btn-pause').addEventListener('click', () => setPaused(!paused));
$('btn-step').addEventListener('click', () => { setPaused(true); world.tick(); });
$('btn-clear').addEventListener('click', () => {
  snapshot();
  world.cells.fill(E.EMPTY); world.meta.fill(0);
});
$('btn-new').addEventListener('click', () => newWorld((Math.random() * 0xffffffff) >>> 0));
$('btn-shot').addEventListener('click', () => {
  view.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pixel-alchemy-${scene}-${seed}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
});
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  $('btn-mute').textContent = muted ? '🔇' : '🔊';
  $('btn-mute').classList.toggle('toggled', muted);
  if (muted) sfx.setCrackle(0); else sfx.ensure();
});
$('btn-help').addEventListener('click', () => $('help').classList.toggle('show'));
$('help-close').addEventListener('click', () => $('help').classList.remove('show'));
$('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').classList.remove('show'); });

for (const btn of document.querySelectorAll('.scenes button')) {
  btn.addEventListener('click', () => {
    scene = btn.dataset.scene;
    for (const b of document.querySelectorAll('.scenes button')) b.classList.toggle('on', b === btn);
    newWorld((Math.random() * 0xffffffff) >>> 0);
  });
}

// --- keyboard ---
const KEY_TO_ELEMENT = {};
for (const [id, k] of Object.entries(KEYS)) KEY_TO_ELEMENT[k.toLowerCase()] = +id;

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); setPaused(!paused); }
  else if (k === '.') { setPaused(true); world.tick(); }
  else if (k === '[') setBrush(brush - 1);
  else if (k === ']') setBrush(brush + 1);
  else if (k === 'c') { snapshot(); world.cells.fill(E.EMPTY); world.meta.fill(0); }
  else if (k === 'r') newWorld((Math.random() * 0xffffffff) >>> 0);
  else if (k === 'm') $('btn-mute').click();
  else if (k === 'p') $('btn-shot').click();
  else if (k === 'h' || k === '?') $('help').classList.toggle('show');
  else if (k === 'escape') $('help').classList.remove('show');
  else if (k in KEY_TO_ELEMENT) selectElement(KEY_TO_ELEMENT[k]);
});

// --- toast hint ---
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 9000);
}
function hideToast() { $('toast').classList.remove('show'); }

// --- footer stats ---
const fScene = $('f-scene'), fTps = $('f-tps'), fFps = $('f-fps'), fCells = $('f-cells'), fAt = $('f-at');
function updateFooterStatic() {
  fScene.innerHTML = `<b>${scene}</b> · seed ${seed}`;
}
let tpsCount = 0, fpsCount = 0, lastRate = performance.now();
let cellCount = 0;

function pollStats() {
  const s = world.stats();
  let live = 0;
  for (let i = 1; i < s.length; i++) live += s[i];
  cellCount = live;
  // open flames drive the crackle; buried magma only murmurs
  sfx.setCrackle((s[E.FIRE] + s[E.LAVA] * 0.12) / 420);
}

// --- main loop ---
const STEP = 1000 / 60;
let acc = 0, lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  acc += Math.min(100, now - lastT);
  lastT = now;
  if (paused) acc = 0;
  let steps = 0;
  while (acc >= STEP && steps < 3) {
    world.tick();
    tpsCount++; steps++;
    acc -= STEP;
    const ev = world.events;
    if (ev.boom) sfx.boom(ev.boomR);
    else if (ev.steam > 2) sfx.hiss(Math.min(1, ev.steam / 30));
    if (world.tickCount % 30 === 0) pollStats();
  }

  animTick++;
  render(world, buf32, animTick, glow32);
  fixEndian(buf32); fixEndian(glow32);
  sctx.putImageData(img, 0, 0);
  gctx.putImageData(glowImg, 0, 0);

  vctx.imageSmoothingEnabled = false;
  vctx.globalCompositeOperation = 'source-over';
  vctx.globalAlpha = 1;
  vctx.drawImage(simCanvas, 0, 0, view.width, view.height);

  // bloom: the quarter-res emissive map, upscaled twice with smoothing
  vctx.imageSmoothingEnabled = true;
  vctx.globalCompositeOperation = 'lighter';
  vctx.globalAlpha = 0.55;
  vctx.drawImage(glowCanvas, 0, 0, view.width, view.height);
  vctx.globalAlpha = 0.22;
  vctx.drawImage(glowCanvas, -view.width * 0.25, -view.height * 0.25, view.width * 1.5, view.height * 1.5);
  vctx.globalCompositeOperation = 'source-over';
  vctx.globalAlpha = 1;

  // brush cursor
  if (mousePt) {
    vctx.beginPath();
    vctx.arc(mousePt.x * SCALE + 1, mousePt.y * SCALE + 1, brush * SCALE, 0, Math.PI * 2);
    vctx.strokeStyle = 'rgba(0,0,0,0.55)';
    vctx.lineWidth = 3;
    vctx.stroke();
    vctx.strokeStyle = 'rgba(255,255,255,0.85)';
    vctx.lineWidth = 1.25;
    vctx.stroke();
  }

  fpsCount++;
  if (now - lastRate >= 1000) {
    fTps.innerHTML = `<b>${tpsCount}</b> tps`;
    fFps.innerHTML = `<b>${fpsCount}</b> fps`;
    fCells.innerHTML = `<b>${(cellCount / 1000).toFixed(1)}k</b> cells`;
    tpsCount = 0; fpsCount = 0; lastRate = now;
  }
  if (mousePt && world.inBounds(mousePt.x, mousePt.y)) {
    fAt.textContent = `${ELEMENTS[world.get(mousePt.x, mousePt.y)].name.toLowerCase()} @ ${mousePt.x},${mousePt.y}`;
  } else {
    fAt.textContent = '';
  }
}

// --- boot ---
newWorld(seed);
selectElement(E.SAND);
setBrush(4);
pollStats();
showToast(scene === 'volcano' ? 'Paint with your mouse — or go poke the volcano 🌋' : 'Paint with your mouse ✦');
requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frame); });

})();
