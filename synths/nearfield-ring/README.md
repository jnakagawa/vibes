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

### What stays gamelan

The piece borrows gamelan's structure, and these parts are the core:

- **Tuning** — by default the stretched octave (2.07) with bell-like partials
  and a scale grown from that sound, the way a gamelan's tuning follows its
  metal. **Slendro** (five equal steps of the stretched octave) is one switch
  away. *Pure* (true octaves, harmonics) is the other end of the tuning dial.
- **Beating (ombak)** — neighboring phones are tuned as a pair, one slightly
  high and one slightly low, like pengumbang and pengisep, so each tone swells
  and fades in the air between them.
- **Nested cycles** — layers turn at 1 : 2 : 4, and the foundation's root
  swells at each turn like a gong marking the cycle.
- **The score** — buka, cycles, the turning, final gong.

### The dials

Eleven dials, each with a live picture of what it does:

| Group | Dial | What it changes |
|---|---|---|
| Tuning and beating | **tuning** | gamelan (stretched) ↔ pure; switch for 4 tones / slendro |
| | **beating** | how long each wave between paired phones takes |
| Voice | **choir** | one exact pitch ↔ a small group drifting around it |
| | **bronze** | bell overtones blooming as a tone arrives, then fading |
| | **vowel** | which vowel the tones sing (oo → ee), and how strongly |
| | **dark** | how much of the top is rolled off |
| | **glints** | faint high harmonics twinkling above |
| Motion | **turning** | seconds for the sound to go once round the ring |
| | **width** | a point between two phones ↔ a cloud over several |
| | **weave** | how many tones rest at a time, and how often they hand over |
| | **drift** | layers turning together ↔ each at its own speed |

Mix has four levels (foundation, tones, high tones, phone volume). Everything
else is under **more settings**.

### The weave

The sound never stops; relief comes from *which* tones are sounding. Time runs
in phrases, and at each **turn** a few tones hand over to others — the new ones
arrive before the old ones have left — while the anchors and the foundation's
deep root never leave. The foundation's color (one degree, two octaves down)
changes at the turns too, and its root swells slightly to mark them. **Space**
sets how many tones are resting at any time; **turn every** sets the phrase
length. This follows a full track of *Incandescence*, which keeps a 6 dB
loudness range for ten minutes while trading tones roughly every 80 seconds.

### Keeping close tones from grating

Sustained tones a step apart grate. Gamelan avoids it by damping (a player
stops the last key when striking the next), by sounding together only tones
on the scale's consonances, and by keeping the low register nearly empty. The
weave does the same in every scale:

- tones closer than about a minor third take turns: when one comes in, its
  neighbor leaves first;
- partners are sought on the consonant intervals (in slendro, three steps or
  an octave; in our own scale, its derived intervals);
- every tone comes round: the longer one has waited, the sooner it is due;
- the foundation carries its root, its octaves and at most one color, an
  octave under the tones and clear of the root's octaves.

**Bronze** gives the color of a struck bar without the strike: as a tone
arrives its bell partials bloom, then die away over seconds, the highest
first, leaving the hum. Anchors flare the same way at each turn.

### Vowels

Each phone has a vowel: the one set on the dial, wandering a little so the
choir never quite agrees. Every partial is weighted by how close it falls to
that vowel's two formants (oo 300/870 Hz, oh 570/840, ah 730/1090, eh 530/1840,
ee 270/2290); partials above 700 Hz that the vowel calls for go round the
darkening filter with the glints.

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
- **Choir** — each phone sings every tone as two voices that drift a few
  cents around the note, each on its own, so a tone is a small group rather
  than one exact pitch. The deep tones stay exact. In the album the bass is a
  razor line while every tone above ~130 Hz is a band about 1% of its pitch
  wide; this reproduces that.
- **Glints** — the shimmer on top. Each tone's own harmonics (x2, x3, x4)
  that land between about 1 and 2.5 kHz sound very faintly, outside the
  darkening filter and mostly as reverb, each twinkling on its own cycle of one
  to three seconds, differently on every phone. They follow the score's
  fullness. This is the register phone speakers are best at.
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
