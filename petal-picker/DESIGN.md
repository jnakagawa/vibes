# Petal Picker — design notes

Goal: upload a flower photo → a three.js 3D flower that resembles it → pick
petals with webcam hand tracking (or mouse) with soft, pliable, realistic
petal physics. "Loves me, loves me not" is the game layer.

## Decisions (and the options considered)

**Photo → 3D.** Three candidate approaches:
1. Image-to-3D mesh service (e.g. via Zero) — best likeness, but produces a
   fused mesh: petals aren't separable bodies, so no per-petal physics. ✗
2. Fully procedural flower + sampled colors — robust but generic-looking. ✗
3. **Chosen:** procedural petal skeleton *parameterized by image analysis*
   (petal count/angles/lengths from radial lobe detection) + **per-petal
   textures sampled from the photo's polar wedges** with alpha cutouts from
   the segmentation mask. Petals are separate physical bodies AND the
   assembled face of the flower reproduces the photo.

**Physics.** Position-based dynamics (Verlet + distance constraints), one
9×4 particle grid per petal. Rigid-body petals with a hinge would be cheaper
but read as stiff plastic; full FEM is overkill. Shape-memory springs give
"alive" turgor while attached; tearing is sustained base-row strain above a
threshold; flutter comes from damping velocity along the surface normal
(paper-fall aerodynamics). All tunables are exposed as live controls
(per Jonah's design-by-live-options preference) rather than pre-decided.

**Hand input.** MediaPipe HandLandmarker (tasks-vision, CDN) — pinch
(thumb–index distance / hand size, with hysteresis) grabs the nearest petal
particle along the camera ray; hand-size change while pinched maps to
pulling the petal toward you. Mouse/touch drag is a first-class fallback so
the toy works without a camera.

**Stack.** Static site, no build step: ES modules + import map, three.js
0.169 and tasks-vision 0.10.14 from jsdelivr. Runs from any static server.

**Zero.** Considered for image→3D and background removal; not used — the
app is fully client-side at runtime and local analysis handles segmentation
well enough. Revisit if likeness on hard photos (busy backgrounds)
disappoints.

## Architecture

- `js/analyzer.js` — photo → {lobes, disk radius, colors, texture bakers}. Pure image code, no three.js.
- `js/builder.js` — analysis → meshes + PetalBody registration. Owns the scene graph & disposal.
- `js/physics.js` — Verlet engine. Pure math, no three.js import; consumes a matrix as number[16].
- `js/input.js` — unified pointers (mouse + two hands) → press/move/release with NDC + pull.
- `js/main.js` — game state, grabbing (ray→particle), loop, UI wiring.
- `js/ui.js`, `js/audio.js` — DOM overlay & synthesized sounds.

Petal meshes share their position Float32Array with the physics particles
(world space), so rendering is the simulation state — no per-frame copies.
