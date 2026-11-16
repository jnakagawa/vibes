# Nearfield — The Ring (web)

A circle of phones plays the ring version of Nearfield: a chord that rotates
around the circle, handed from phone to phone. No app and no server — every
phone computes the whole piece from the shared performance state and its own
clock, and plays only the voices passing through its position.

- `host.html` — controls, score transport, join QR, printable QR per position, live ring monitor
- `play.html` — what each phone opens (`#t=<topic>&pos=<n>&s=<state>`)
- `ring-core.js` — the piece (deterministic; tested in `test/`)
- `ring-live.js` — live control via a public ntfy.sh topic + clock check
- `ring-audio.js` — per-phone synthesis, the air layer, and the host's headphone monitor
- `qr.js` — tiny QR encoder (no CDN)
- `config/` — tuning, voicing and score, copied from `nearfield-ios/config`

## Composing on headphones

**Listen on headphones → listen to the whole ring** on the host renders every
position around your head (with the time sound takes to reach you), so the
piece can be shaped without setting out phones. It plays on the host only.

The piece is layers of slow cycles that never quite line up:

- **Mix** — levels for anchors, tones, shimmer and air.
- **Shape** — *density* (how much of the chord sounds at once; each tone swells
  in and out on its own tide), *drift* (how far apart the cycles run),
  *softness* (darker, slower fades), *beat depth* (how much the tuning shimmers).
- **Layers** — each layer's width (a point hopping between two phones, or a
  cloud over several) and whether it turns with or against the rotation.
- **Air** — soft noise, each phone its own, circling the ring and swelling with
  the breath; its tone wanders across the scale's notes.

The line under the ring shows each layer's seconds per turn and how many tones
the tides have up.

### Space

The whole ring swells in and recedes together, phrase by phrase, with rests
between: the tones leave first and return last, the foundation holds longest.
**Space** sets how much of each phrase is rest (0 = continuous sound) and
**phrase length** how long a phrase is.

### Warmth (measured against Aleksi Perälä's *Incandescence*)

- **Foundation** — a deep tone with its octaves and fifth (55 Hz up). Phones
  cannot play it: put a real speaker in the middle and open the **center
  speaker** link (position `P`) on whatever drives it. The headphone monitor
  always includes it.
- **Breathing** — neighboring phones play each partial a fraction of a hertz
  apart, so wherever a tone sounds on two phones every partial swells and
  fades between them over a few seconds, each at its own rate.
- **Tuning** — *stretched* is the gamelan-derived scale with bell-like
  partials; *pure* has true octaves, harmonics and just intervals, which fuse
  into one warm sound.
- **Softness** now rolls off much more steeply (24 dB per octave, down to
  500 Hz). Air is off by default.

## Testing with a bunch of phones

1. On a laptop, open **host.html** (from the vibes page: *nearfield_ring → HOST A RING*).
   It creates a performance and shows a QR code.
2. Set **positions** to the number of phones you have (start with 4–8).
3. Put the phones in a circle, roughly evenly spaced — a small circle on a table
   (about 1 m across) is a good start. Number the spots 1…N clockwise.
4. Each phone: scan the QR with the camera → pick its number → **BEGIN**.
   Volume all the way up. Leave the page open, screen up.
   (Or use **print position QR codes**: each code joins straight to its spot.)
5. You should hear the chord walk around the circle (default: one turn per breath,
   60 s). Walk around the circle with it, then against it.
6. **▶ start score** plays the 16-minute arc (set *time compression* 8× or 16× to
   audition it in 1–2 minutes). *from turning* etc. jump into a section.
7. Every control on the host reaches the phones in a second or two.

### If something's off

- **No sound on an iPhone** — check the volume buttons; the page asks iOS for a
  playback session (silent switch shouldn't matter, but flip it if needed).
  Tap the screen once if Safari suspended audio.
- **A phone is out of step** — its clock is off. The bottom-right of its screen
  shows `clock ok` or a correction; reloading it re-checks.
- **Low end missing** — anchors are lifted by default so phone speakers can play
  them. *anchors: on a pedestal device* sends them to a laptop in the middle
  instead (open the `P` link on it).
- **Host offline** — phones keep playing from their link; changes just won't reach
  them until the relay is back.

### Local network (no internet)

`python3 -m http.server 8000` in the vibes root, open
`http://<mac-ip>:8000/synths/nearfield-ring/host.html`. Live control still needs
ntfy.sh (internet); without it, generate the QR after setting things up.
Screen wake-lock only works over https.

## Tests

```bash
node --test synths/nearfield-ring/test/ring-core.test.mjs
```
