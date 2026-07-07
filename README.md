# Vibes

**[jnakagawa.github.io/vibes](https://jnakagawa.github.io/vibes/)** — a field guide to things I've built, so I don't forget.

Sound installations, hand-tracked instruments, iOS apps, and web experiments — mostly about music, gesture, and making computers feel less like computers.

## Featured

| App | What it is | Where |
|---|---|---|
| **Nearfield** 👑 | UWB sound installation — phones create richer harmonics as people get closer | [repo](https://github.com/jnakagawa/nearfield-ios) · iOS |
| **YomiScan** | Photograph Japanese → furigana + dictionary + translation, 100% on-device | [repo](https://github.com/jnakagawa/yomiscan) · TestFlight |
| **Glass Conductor v3** | Conduct Philip Glass with your hands — gestural particle instrument | [live](https://jnakagawa.github.io/vibes/synths/glass-conductor-v3.html) |
| **Stackify Social** | The mailing list for Instagram | [stackify.social](https://stackify.social) |
| **Stackify Calendar** | The events come to you | [calendar.stackify.social](https://calendar.stackify.social) |
| **Petal Picker** | Photo → 3D flower; pinch the petals off with your hands | [live](https://jnakagawa.github.io/vibes/petal-picker/) |
| **Sound Catcher** | Pocket granular sampler with a TE-inspired UI | [live](https://jnakagawa.github.io/vibes/synths/sound_catcher.html) |

## The lab

Everything else lives in [`synths/`](./synths) — theremins, FM synths, Eno loop machines, a climbing RPG, an ASCII webcam, and other experiments. The [showcase page](https://jnakagawa.github.io/vibes/) auto-discovers them from `files.json`.

## Development

```bash
npm run build   # regenerate files.json after adding a synth
npm run dev     # build + serve on :8000
```

Each instrument is a standalone HTML file with everything inlined — no build step, no external dependencies. See [CLAUDE.md](./CLAUDE.md) for architecture notes and [DEPLOYMENT.md](./DEPLOYMENT.md) for hosting.

---

*Hand-tracked synthesizers • Real-time audio • Browser-based • Good vibes only*
