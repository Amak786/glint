# Glint

A seated, hands-first light puzzle for Meta VR devices, built with the Immersive Web SDK (WebXR).

**Play it:** https://amak786.github.io/glint/

A small board floats in front of your chest. Touch a mirror with your fingertip to turn it, bounce the beams around walls and through glass, and light every crystal at once.

## How to play

- **Touch** a mirror with your index finger to turn it. You can also point at it and **pinch**.
- Light every crystal. Gold light fills diamonds, blue light fills cubes, and white faceted crystals need both colours at once.
- Glass pieces split a beam in two. Dark-framed mirrors are fixed.
- Buttons along the near edge: previous / next level, Reset, Hint, Daily, Center (brings the board back in front of you).

No controllers are needed at any point. Everything sits inside a two-foot reach, so it plays in an armchair or an airplane seat.

## What is in it

- 12 campaign levels that ramp from one mirror to two colours, splitters, fixed mirrors and colour-mixing crystals
- Two ways in: a quiet night-sky VR room, or Mixed Reality with the board floating in your own room
- Gaze-and-pinch selection on devices that offer eye tracking (requested as an optional feature; hands always work)
- A progress map along the board edge showing every level's stars
- A new Daily Glint puzzle every day, with a streak counter
- Star ratings against a par (fewest possible taps), saved between sessions
- A hint that points at the next mirror on the shortest solution
- Shape as well as colour on every emitter and crystal, so it does not rely on colour vision
- All sound synthesised at runtime; no asset downloads

## Run it

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5183. On a desktop browser the SDK's emulator provides a headset and hands; the mouse also works on the flat page. On a Quest, open the deployed URL in the browser and press **Enter VR**.

```bash
npm run check      # proves every campaign level and 30 daily puzzles are solvable
npm run typecheck
npm run build      # static site in dist/
```

## Deploy to GitHub Pages

Push this folder to a GitHub repository, then in the repository's Settings → Pages choose **GitHub Actions** as the source. The included workflow builds and publishes `dist/` on every push to `main`.

## How it works

- `src/puzzle.ts` — grid, beam tracing, level generator and brute-force solver. Levels are generated from fixed seeds, then verified: the solver confirms each has a solution and computes par.
- `src/main.ts` — scene, pieces, hand interaction (poke and ray-pinch through the SDK's `PokeInteractable` and `RayInteractable`), UI and progression.
- `src/audio.ts` — Web Audio synth for taps, crystals and the win chime.

## License

MIT
