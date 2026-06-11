# ⚗ Pixel Alchemy

*A tiny living world in a sandbox — 18 elements, real chemistry, procedural islands, zero dependencies.*

![A procedurally generated volcano island, mid-eruption: lava cascades down the right flank into the sea while the cabin on the left flank survives by its spring](docs/volcano.png)

That image was not drawn. It was **simulated**: a procedurally generated island whose crater rim was breached, rendered headlessly by the same engine that runs in your browser — lava flowed downhill on its own, set the trees alight, and turned to stone where it met the sea.

## Play

```bash
./play.sh          # or just open index.html in any browser
```

No install, no server, no build step, works offline. One HTML file, two scripts.

- **Paint** with the left mouse button, **erase** with the right.
- **Mouse wheel** (or `[` `]`) resizes the brush.
- `Space` pauses, `.` steps one tick, `Ctrl+Z` undoes.
- `R` regenerates the scene with a fresh seed — every island that ever existed, one keypress apart.
- Press `H` in-app for the full field guide.

Try, in roughly this order: pour water on the lava pool · crack the crater rim open with the eraser · drop a seed of plant into the sea · find what's buried under the seabed (there are three secrets) · then press `6` and make your peace with the cabin.

## The elements

| | | |
|---|---|---|
| **Sand** falls, piles, fuses to glass near lava | **Water** flows, levels, boils, freezes | **Oil** floats on water and burns hard |
| **Acid** dissolves almost everything | **Lava** ignites, melts, forges stone | **Fire** spreads, clings to fuel, dies young |
| **Smoke** rises and fades | **Steam** rises, cools, rains back down | **Wood** is patient fuel |
| **Plant** drinks water to grow | **Ice** creeps across still water | **Gunpowder** chain-detonates |
| **Glass** is fragile but acid-proof | **Stone** is honest rock | **Wall** outlives everything |
| **Spout** weeps water forever | **Void** devours whatever touches it | **Eraser** is your undo-in-place |

The fun is the matrix of interactions: lava + water → stone + steam; steam + ice → rain; fire + gunpowder → chain reactions that excavate craters; explosions shatter glass back into the sand it came from.

## Scenes

- **Volcano** *(default)* — an island with a live magma chamber, beaches, trees, a cabin with a lit hearth, a mountain spring, icebergs, and three buried secrets. Stable until provoked.
- **Springs** — terraced basins cascading into one another, glass lanterns, slow gardens.
- **Blank** — an empty box and your imagination.

## How it works

The whole simulation is `engine.js` — pure logic, no DOM — which is why the *same file* runs in the browser, in the test suite, and in the screenshot renderer.

- **Cellular automaton** over a 384×240 grid of typed arrays: one bottom-up pass per tick, alternating x-direction per row to avoid bias, with a parity flag per cell so nothing moves twice in a tick.
- **Powders** sink through lighter fluids by density swap; **liquids** disperse laterally with per-element flow distance (water glides 6 cells, lava lumbers 1); **gases** rise, drift, and bubble through liquids.
- **Explosions** queue during the tick and resolve at the end — gunpowder inside the blast radius queues again, which is what makes chains feel like chains.
- **Deterministic by construction**: every random draw comes from a seeded mulberry32 stream, so the same seed always produces the same world, tick for tick. The test suite proves it by hashing two parallel universes.
- **Rendering** packs RGBA pixels straight into a `Uint32Array`, with per-cell shade noise, animated shimmer for water/fire/lava, depth-shaded terrain, twinkling stars in empty sky — and a bloom pass built from a quarter-res emissive map upscaled with smoothing.

## Proof it works (without a browser)

```bash
node test/run-tests.js
```

17 behavioral tests: sand conservation, water finding its level, oil floating, the steam→rain cycle, acid respecting glass, plants conserving mass as they drink, gunpowder chains, walls surviving everything, full determinism + snapshot/restore lockstep, and a chaos-soup crash test. Runs at ~1,200 ticks/sec headless — about 20× real time.

```bash
node tools/screenshot.js --scene volcano --seed 7 --ticks 300 --erupt --out docs/volcano.png
```

The screenshot tool simulates a scene (optionally staging an eruption by boring a fissure through the crater wall), renders it with a software bloom pass, and encodes the PNG **by hand** — `tools/png.js` is a from-scratch PNG writer in ~60 lines on top of node's zlib. Every image in this README came out of it, except `docs/app-live.png`, which is the real app captured in headless Chrome as a final end-to-end check.

![The springs scene: terraced basins cascading water, plants growing along the waterlines](docs/springs.png)

## Files

```
pixel-alchemy/
├── index.html          the app shell
├── style.css           dark glass UI
├── app.js              rendering, input, procedural WebAudio, UI wiring
├── engine.js           the world: elements, physics, scenes, palette
├── play.sh             opens the game (WSL/Linux/macOS aware)
├── test/run-tests.js   17 deterministic behavioral tests
├── tools/png.js        hand-rolled PNG encoder
├── tools/screenshot.js headless scene renderer with bloom
└── docs/               images rendered by the engine itself
```

---

Built end-to-end in one session by **Claude (Fable 5)** — engine, app, sound, tests, screenshot pipeline, and the eruption you see above. The sound is procedural too: every bloop, hiss, crackle, and boom is synthesized from math at the moment it happens.
