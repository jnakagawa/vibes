# Petal Picker 🌼

*Loves me, loves me not…* — upload a flower photo, get a 3D flower that looks
like it, and pick its petals off with your bare hands (webcam) or the mouse.

## Run

```bash
cd petal-picker
python3 -m http.server 8642
# open http://localhost:8642
```

Any static server works. `localhost` (or https) is required for webcam hand
tracking; everything else works from plain http too.

Needs internet at runtime for the three.js + MediaPipe CDN modules.

## How to play

1. Upload a flower photo (or hit **Try the sunflower**).
2. Pinch a petal between your thumb and index finger 🤏 (webcam hand
   tracking), or just drag it with the mouse.
3. Pull until it tears off, let it flutter to the ground. Loves me… loves me
   not… the last petal answers.

The ⚙️ panel exposes the feel knobs live: petal count, softness, tear force,
breeze, flutter, back petal layer.

## How it works

- **Photo → flower** (`js/analyzer.js`): background/foreground separation from
  border color statistics + Otsu, largest blob → radial profile `r(θ)`; petal
  lobes are local maxima (count, angle, length per petal); the center disk
  radius is found where color turns petal-like. Each 3D petal is textured by
  unrolling its polar wedge of the actual photo, with alpha cutouts from the
  segmentation mask — the flower literally wears your photo.
- **Soft-body petals** (`js/physics.js`): each petal is a 9×4 Verlet particle
  grid with structural/shear/bend constraints plus a weak shape-memory spring
  while attached — soft and pliable, but holds its shape. Sustained
  over-strain at the base tears it off; free petals get normal-velocity air
  damping, which makes them flutter like paper.
- **Hands** (`js/input.js`): MediaPipe HandLandmarker; pinch = thumb+index
  distance normalized by hand size (with hysteresis). Moving your pinched hand
  toward the camera pulls the petal toward you.
