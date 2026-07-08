// main.js — app orchestration: scene, game state, input wiring, render loop.

import * as THREE from 'three';
import { analyzeFlower } from './analyzer.js';
import { PetalPhysics, GRID } from './physics.js';
import { createEnvironment, buildFlower, HEAD_TILT } from './builder.js';
import { createGrass } from './grass.js';
import { InputManager } from './input.js';
import { UI } from './ui.js';
import { Sound } from './audio.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 1.42, 3.7);
const LOOK_AT = new THREE.Vector3(0, 1.32, 0);

createEnvironment(scene);
const grass = createGrass(scene);

const ui = new UI();
const sound = new Sound();
const input = new InputManager(canvas, document.getElementById('cursors'));
const physics = new PetalPhysics();

const ctl = {
  softness: 0.6,
  tear: 0.18,
  breeze: 0.35,
  flutter: 0.5,
  count: 0,          // 0 = auto
  backLayer: true,
  hands: true,
};

const state = {
  analysis: null,
  model: null,
  picked: 0,
  finished: false,
  grabs: new Map(),   // pointer id -> { petal, along }
  wobble: { rx: 0, rz: 0, vx: 0, vz: 0 },
};

function applyParams() {
  physics.params.kShape = 0.16 - 0.14 * ctl.softness;
  physics.params.tearDist = ctl.tear;
  physics.params.breeze = ctl.breeze;
  physics.params.air = ctl.flutter;
}
applyParams();

// ---------------- game flow ----------------

// rAF, but resolve anyway if the tab is hidden (rAF is suspended there)
const frame = () => new Promise(r => { requestAnimationFrame(r); setTimeout(r, 120); });

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = src;
  });
}

async function startGame(imgSrc) {
  ui.hideLanding();
  ui.hideEnd();
  ui.showLoader('reading the photo…');
  await frame(); await frame();
  let img;
  try {
    img = await loadImage(imgSrc);
  } catch {
    ui.hideLoader();
    ui.toast('Could not read that image — try a JPG/PNG/AVIF');
    ui.showLanding();
    return;
  }
  ui.setLoaderStep('finding the petals…');
  await frame();
  try {
    state.analysis = analyzeFlower(img);
  } catch (err) {
    console.error('analysis failed', err);
    ui.hideLoader();
    ui.toast('Could not make sense of that photo — try another one');
    ui.showLanding();
    return;
  }
  ui.setLoaderStep('growing your flower…');
  await frame();
  rebuild();
  ui.hideLoader();
  ui.showToolbar();
  ui.setPhrase('pick a petal…');
  if (!state.analysis.ok) {
    ui.toast('Couldn’t isolate a flower in that photo — improvised one from its colors 🌼');
  }
  if (ctl.hands) ensureHands();
}

function rebuild() {
  releaseAllGrabs();
  if (state.model) state.model.dispose();
  physics.clear();
  applyParams();
  state.model = buildFlower({
    scene,
    analysis: state.analysis,
    physics,
    options: { count: ctl.count || null, doubleLayer: ctl.backLayer },
  });
  state.picked = 0;
  state.finished = false;
  ui.hideEnd();
  ui.setPetalsLeft(state.model.totalPetals);
  ui.setPhrase('pick a petal…');
}

physics.onTear = () => {
  state.picked++;
  const left = physics.attachedCount();
  const lovesMe = state.picked % 2 === 1;
  ui.setPhrase(lovesMe ? 'loves me…' : 'loves me not…', true);
  ui.setPetalsLeft(left);
  sound.tear(state.picked);
  state.wobble.vx += (Math.random() - 0.3) * 0.6;
  state.wobble.vz += (Math.random() - 0.5) * 0.8;

  if (left === 0 && !state.finished) {
    state.finished = true;
    const verdict = lovesMe ? 'LOVES ME' : 'LOVES ME NOT';
    setTimeout(() => {
      sound.chord(lovesMe);
      ui.showEnd(
        verdict,
        `the flower gave up all ${state.picked} petals to tell you`,
        lovesMe ? '🌼' : '🥀'
      );
    }, 1300);
  }
};

// ---------------- picking ----------------

const raycaster = new THREE.Raycaster();
const _v = new THREE.Vector3();

function tryGrab(id, ndc) {
  if (!state.model) return null;
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  let best = null;
  for (const petal of physics.petals) {
    const startIdx = petal.attached ? GRID.COLS : 0;
    const { pos } = petal;
    for (let i = startIdx; i < pos.length / 3; i++) {
      const q = i * 3;
      const vx = pos[q] - origin.x, vy = pos[q + 1] - origin.y, vz = pos[q + 2] - origin.z;
      const along = vx * direction.x + vy * direction.y + vz * direction.z;
      if (along < 0.4 || along > 25) continue;
      const px = vx - direction.x * along;
      const py = vy - direction.y * along;
      const pz = vz - direction.z * along;
      const perp = Math.sqrt(px * px + py * py + pz * pz);
      if (perp > 0.26) continue;
      const score = perp + along * 0.02;
      if (!best || score < best.score) best = { petal, idx: i, along, score };
    }
  }
  if (!best) return null;
  best.petal.wake();
  _v.copy(origin).addScaledVector(direction, best.along);
  best.petal.grab = { idx: best.idx, x: _v.x, y: _v.y, z: _v.z };
  state.grabs.set(id, { petal: best.petal, along: best.along });
  sound.ensure();
  sound.grab();
  return best;
}

function moveGrab(id, ndc, pull) {
  const g = state.grabs.get(id);
  if (!g) return;
  raycaster.setFromCamera(ndc, camera);
  const depth = g.along * (1 - 0.4 * Math.min(Math.max(pull, -0.5), 1.2));
  _v.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, depth);
  g.petal.grab.x = _v.x;
  g.petal.grab.y = _v.y;
  g.petal.grab.z = _v.z;
}

function releaseGrab(id) {
  const g = state.grabs.get(id);
  if (!g) return;
  g.petal.grab = null;
  state.grabs.delete(id);
}

function releaseAllGrabs() {
  for (const id of [...state.grabs.keys()]) releaseGrab(id);
}

input.handlers.press = tryGrab;
input.handlers.move = moveGrab;
input.handlers.release = releaseGrab;

// ---------------- hand tracking ----------------

const tbHand = document.getElementById('tb-hand');

input.onHandsLost = () => {
  ui.el.camwrap.hidden = true;
  tbHand.classList.add('off');
  ui.toast('Camera stopped — drag with the mouse, or tap ✋ to reconnect');
};

async function ensureHands() {
  if (input.handsActive) return;
  try {
    await input.startHands(document.getElementById('cam'), document.getElementById('camoverlay'));
    ui.el.camwrap.hidden = false;
    tbHand.classList.remove('off');
    ui.toast('Hand tracking on — pinch a petal 🤏 and pull it off');
  } catch (err) {
    console.warn('hand tracking unavailable:', err);
    ctl.hands = false;
    tbHand.classList.add('off');
    ui.toast('Camera unavailable — drag petals with the mouse instead');
  }
}

function stopHands() {
  input.stopHands();
  ui.el.camwrap.hidden = true;
  tbHand.classList.add('off');
}

tbHand.addEventListener('click', () => {
  ctl.hands = !input.handsActive;
  if (ctl.hands) ensureHands();
  else stopHands();
});

// ---------------- UI wiring ----------------

const fileInput = document.getElementById('file-input');

document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) startGame(URL.createObjectURL(fileInput.files[0]));
  fileInput.value = '';
});
document.getElementById('btn-sample').addEventListener('click', () => startGame('assets/sunflower.jpg'));
document.getElementById('btn-replay').addEventListener('click', () => { ui.hideEnd(); rebuild(); });
document.getElementById('btn-new').addEventListener('click', () => { ui.hideEnd(); ui.showLanding(); });
document.getElementById('tb-new').addEventListener('click', () => ui.showLanding());
document.getElementById('tb-replay').addEventListener('click', rebuild);
document.getElementById('tb-gear').addEventListener('click', () => ui.togglePanel());

const dropzone = ui.el.dropzone;
window.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
window.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) startGame(URL.createObjectURL(file));
});

window.addEventListener('pointerdown', () => sound.ensure(), { once: true });

let rebuildTimer = null;
const debouncedRebuild = () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { if (state.analysis) rebuild(); }, 300);
};

ui.buildPanel([
  {
    type: 'range', label: 'Petals', min: 0, max: 40, step: 1, value: ctl.count,
    fmt: v => v === 0 ? 'auto' : v,
    onChange: v => { ctl.count = v; debouncedRebuild(); },
  },
  {
    type: 'range', label: 'Softness', min: 0.2, max: 0.95, step: 0.05, value: ctl.softness,
    fmt: v => v.toFixed(2),
    onChange: v => { ctl.softness = v; applyParams(); },
  },
  {
    type: 'range', label: 'Tear force', min: 0.1, max: 0.55, step: 0.025, value: ctl.tear,
    fmt: v => v.toFixed(2),
    onChange: v => { ctl.tear = v; applyParams(); },
  },
  {
    type: 'range', label: 'Breeze', min: 0, max: 1, step: 0.05, value: ctl.breeze,
    fmt: v => v.toFixed(2),
    onChange: v => { ctl.breeze = v; applyParams(); },
  },
  {
    type: 'range', label: 'Flutter', min: 0.05, max: 0.9, step: 0.05, value: ctl.flutter,
    fmt: v => v.toFixed(2),
    onChange: v => { ctl.flutter = v; applyParams(); },
  },
  {
    type: 'check', label: 'Back petal layer', value: ctl.backLayer,
    onChange: v => { ctl.backLayer = v; debouncedRebuild(); },
  },
  {
    type: 'check', label: 'Sound', value: sound.enabled,
    onChange: v => { sound.enabled = v; },
  },
]);

// ---------------- render loop ----------------

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();

function tick(nowMs) {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = nowMs / 1000;

  input.update(nowMs);

  if (state.model) {
    // head wobble spring (excited by tears) + breeze sway
    const w = state.wobble;
    w.vx += (-w.rx * 90 - w.vx * 8) * dt;
    w.vz += (-w.rz * 90 - w.vz * 8) * dt;
    w.rx += w.vx * dt;
    w.rz += w.vz * dt;
    const rig = state.model.headRig;
    rig.rotation.x = w.rx;
    rig.rotation.z = w.rz + 0.025 * Math.sin(t * 0.6) * physics.params.breeze;
    state.model.group.updateMatrixWorld(true);

    physics.params.headCollider = state.model.headCollider();
    physics.step(dt, state.model.headGroup.matrixWorld.elements, t);

    for (const petal of physics.petals) {
      if (petal.sleeping && !petal.grab) continue;
      petal.geometry.attributes.position.needsUpdate = true;
      petal.geometry.computeVertexNormals();
    }
  }

  grass.update(t, physics.params.breeze);

  // gentle camera parallax
  camera.position.x += (input.mouseNdc.x * 0.12 - camera.position.x) * 0.04;
  camera.position.y += (1.42 + input.mouseNdc.y * 0.06 - camera.position.y) * 0.04;
  camera.lookAt(LOOK_AT);

  renderer.render(scene, camera);
}
requestAnimationFrame(tick);

// debug/testing hook
window.__pp = { physics, state, camera, ctl, input, tryGrab, startGame };
