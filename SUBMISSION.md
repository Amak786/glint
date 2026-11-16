# Devpost submission — Glint

Deadline: **18 November 2026, 12:00 PM Pacific Time** (19 November, 1:30 AM India time).

The rules void entries submitted by a bot or by someone else on your behalf, so you must fill in and submit the form yourself. Read this text, change anything that is not true for you, and paste it in.

## What you still have to do

1. **Join the Meta VR Start program** and make sure your Meta account has Developer Access. The rules require both by the time you submit.
2. **Put the game online.** Create a GitHub repository, push this folder, and turn on Pages (Settings → Pages → Source: GitHub Actions). Your link will look like `https://<your-username>.github.io/<repo-name>/`.
3. **Test on a real Quest if you can.** Open the link in the Quest browser, put the controllers down, press Enter VR and play a few levels with your hands. I could only test in the SDK's emulator.
4. **Record a video under 3 minutes** from the headset or the emulator (`npm run dev`, then Enter XR and switch the emulator to hands). Upload it to YouTube or Vimeo as public.
5. **Click "Join Hackathon"** on the competition page, then fill in the submission form with the text below.

## Form answers

**Submission name:** Glint

**Tagline:** Turn mirrors with your fingertips and bend light into crystals. A calm, seated puzzle you can finish between two bus stops.

**Track:** Gaming

**Division:** New Experience

**Project link:** your GitHub Pages URL

**Target launch date:** choose your own date

### Description

**Inspiration**

I wanted a VR game that asks for nothing: no controllers, no room, no standing up, no tutorial to read. Light-and-mirror puzzles are easy to understand at a glance, and turning a small mirror is something a fingertip does well. Glint is that idea on a board the size of a book.

**What it does**

A tilted board floats in front of your chest. Emitters fire beams of light across it. You touch a mirror to turn it, and the beam re-routes instantly. Light every crystal at once to solve the puzzle. Later levels add glass that splits a beam in two, fixed mirrors you have to work around, and a second colour of light.

- 12 campaign levels, each solvable in under a minute
- A new Daily Glint every day, with a streak counter
- Star ratings against par (the fewest possible taps), saved between sessions
- A hint button that points at the next mirror on the shortest solution

**How I built it**

Glint is a WebXR app built with Meta's Immersive Web SDK, TypeScript and Vite, developed with AI coding tools. Levels come from a seeded generator: it places emitters and mirrors, traces the light, drops crystals on the lit path, then scrambles the mirrors. A brute-force solver checks every mirror combination, rejects boards that are too easy, and sets par. A test script proves all 12 levels and the next 30 daily puzzles are solvable. All sound is synthesised with Web Audio, so there are no assets to download and it starts fast.

**Challenges**

Fingers are imprecise, so each mirror has a touch target larger than the mirror itself, and a poke and a pinch landing together count as one tap. The board has to be reachable without leaning, so it places itself from your head position when the session starts, and a Center button brings it back.

**What's next**

Passthrough mode that anchors the board to a real table, more piece types (colour filters, prisms that mix light), a level editor for sharing puzzles, and gaze-and-pinch selection for devices with eye tracking.

### Hand interactions

Every action uses hands only. Touching a mirror with the index fingertip turns it; this uses the SDK's poke interaction. Pointing at a mirror and pinching does the same from a distance, for players who prefer not to reach. The six menu buttons work the same two ways. Hovered pieces grow and brighten before you commit. The whole board fits inside a 42 cm square, about 46 cm in front of you, so it passes the airplane-seat test.

### Accessibility note

Colour is never the only cue: gold light always pairs with diamond shapes and blue with cubes, on both emitters and crystals. Point-and-pinch means the game is playable without reaching forward.
