// builder.js — assembles the three.js flower from an analysis result and
// registers each petal with the physics system.
//
// Petal meshes share their position buffer with the physics particles (world
// space), so rendering IS the simulation state; meshes sit at the scene root.

import * as THREE from 'three';
import { GRID, PetalBody } from './physics.js';

export const HEAD_POS = new THREE.Vector3(0, 1.55, 0);
export const HEAD_TILT = 0.24;   // radians, face tips down toward the camera

// ---------- environment (once per app) ----------

export function createEnvironment(scene) {
  scene.background = gradientTexture('#f4f1e0', '#d7e0bf');

  const hemi = new THREE.HemisphereLight(0xfff8ec, 0x9a8a72, 1.0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff1da, 1.9);
  key.position.set(2.5, 5, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -3.5; key.shadow.camera.right = 3.5;
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 12;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 4;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xd8e6ff, 0.5);
  rim.position.set(-3, 2.5, -2.5);
  scene.add(rim);

  const groundTex = radialTexture('#7f9e5b', '#617e47');
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

// ---------- flower ----------

export function buildFlower({ scene, analysis, physics, options = {} }) {
  const group = new THREE.Group();        // stem, leaves (static, world)
  const headRig = new THREE.Group();      // wobble/sway animates this
  const headGroup = new THREE.Group();    // petal/disk local frame (faces +Z)
  headRig.position.copy(HEAD_POS);
  headGroup.rotation.x = HEAD_TILT;
  headRig.add(headGroup);
  group.add(headRig);
  scene.add(group);
  headRig.updateMatrixWorld(true);

  const rd = analysis.rdNorm;
  const disposables = [];

  // --- petal layout ---
  let lobes = analysis.lobes;
  if (options.count && options.count !== lobes.length) {
    lobes = [];
    for (let i = 0; i < options.count; i++) {
      lobes.push({
        angle: (i / options.count) * Math.PI * 2,
        lenNorm: 0.96 + 0.07 * Math.sin(i * 2.13),
      });
    }
  }
  const count = lobes.length;
  const wedge = (Math.PI * 2 / count) * 1.06;

  const rings = [{ lobes, lenScale: 1, zBase: 0, tint: 0xffffff }];
  const doubleLayer = options.doubleLayer !== false && count < 18;
  if (doubleLayer) {
    rings.push({
      lobes: lobes.map(l => ({ angle: l.angle + Math.PI / count, lenNorm: l.lenNorm * 0.85 })),
      lenScale: 0.85, zBase: -0.085, tint: 0xb9b3a8,
    });
  }

  const petals = [];
  headGroup.updateMatrixWorld(true);
  const headEls = headGroup.matrixWorld.elements;

  let petalIndex = 0;
  for (const ring of rings) {
    for (const lobe of ring.lobes) {
      const phi = -lobe.angle;                       // image y-down -> world y-up
      const rootR = rd * 0.95;
      const len = Math.max(0.28, lobe.lenNorm - rootR) * ring.lenScale;
      const width = clamp(wedge * (rootR + len * 0.55) * 0.95, 0.1, 0.52);

      const restLocal = petalRestPositions(phi, rootR, len, width, ring.zBase);
      const petal = new PetalBody(restLocal, petalIndex++);

      const { canvas } = analysis.makePetalTexture(lobe.angle, wedge, lobe.lenNorm);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: ring.tint,
        side: THREE.DoubleSide,
        roughness: 0.62,
        metalness: 0,
        alphaTest: 0.35,
      });
      const geo = petalGeometry(petal);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: tex,
        alphaTest: 0.35,
      });
      petal.geometry = geo;
      petal.mesh = mesh;
      scene.add(mesh);
      physics.add(petal, headEls);
      petals.push(petal);
      disposables.push(geo, mat, tex, mesh.customDepthMaterial);
    }
  }

  // --- receptacle (photo-textured disk) ---
  const diskTex = new THREE.CanvasTexture(analysis.makeDiskTexture());
  diskTex.colorSpace = THREE.SRGBColorSpace;
  const diskGeo = new THREE.CircleGeometry(rd * 1.0, 48);
  domeDisplace(diskGeo, rd * 1.0, rd * 0.15);
  const diskMat = new THREE.MeshStandardMaterial({
    map: diskTex, roughness: 0.85, side: THREE.DoubleSide,
  });
  const disk = new THREE.Mesh(diskGeo, diskMat);
  disk.position.z = 0.02;
  disk.castShadow = true;
  headGroup.add(disk);
  disposables.push(diskGeo, diskMat, diskTex);

  const backGeo = new THREE.SphereGeometry(1, 24, 16);
  const backMat = new THREE.MeshStandardMaterial({ color: 0x3c5a26, roughness: 0.9 });
  const back = new THREE.Mesh(backGeo, backMat);
  back.scale.set(rd * 1.12, rd * 1.12, rd * 0.36);
  back.position.z = -0.12;
  back.castShadow = true;
  headGroup.add(back);
  disposables.push(backGeo, backMat);

  // --- stem + leaves ---
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.5, -0.12),
    new THREE.Vector3(0.03, 1.15, -0.15),
    new THREE.Vector3(0.10, 0.6, -0.09),
    new THREE.Vector3(0.14, 0, -0.02),
  ]);
  const stemGeo = new THREE.TubeGeometry(curve, 32, 0.042, 10);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a7a2e, roughness: 0.8 });
  const stem = new THREE.Mesh(stemGeo, stemMat);
  stem.castShadow = true;
  group.add(stem);
  disposables.push(stemGeo, stemMat);

  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x58863a, roughness: 0.8, side: THREE.DoubleSide,
  });
  for (const [t, side, tilt] of [[0.55, 1, -0.55], [0.74, -1, -0.85]]) {
    const p = curve.getPoint(t);
    const leaf = new THREE.Mesh(leafGeometry(), leafMat);
    leaf.scale.setScalar(0.8);
    leaf.position.set(p.x + side * 0.16, p.y - 0.02, p.z);
    leaf.rotation.set(tilt, side * 0.5, side * 0.35);
    leaf.castShadow = true;
    group.add(leaf);
    disposables.push(leaf.geometry);
  }
  disposables.push(leafMat);

  const model = {
    group, headRig, headGroup, petals,
    totalPetals: petals.length,
    rd,
    headCollider() {
      const v = new THREE.Vector3(0, 0, -0.06).applyMatrix4(headGroup.matrixWorld);
      return { x: v.x, y: v.y, z: v.z, r: rd * 1.12 };
    },
    dispose() {
      for (const petal of petals) scene.remove(petal.mesh);
      scene.remove(group);
      for (const d of disposables) if (d.dispose) d.dispose();
    },
  };
  return model;
}

// petal rest pose in head-local space (head faces +Z)
function petalRestPositions(phi, rootR, len, width, zBase) {
  const { ROWS, COLS } = GRID;
  const out = new Float32Array(ROWS * COLS * 3);
  const lx = Math.cos(phi), ly = Math.sin(phi);
  const wx = -Math.sin(phi), wy = Math.cos(phi);
  const pitch = (Math.random() - 0.5) * 0.14;
  const twist = (Math.random() - 0.5) * 0.12;
  const z0 = zBase + (Math.random() - 0.5) * 0.02 - 0.045;

  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1);
    const rad = rootR + t * len;
    const taper = 1 - 0.4 * t * t;                     // gentle tip taper
    const zc = z0 + 0.10 * Math.sin(t * Math.PI * 0.9) + 0.15 * t * t + pitch * t;
    for (let c = 0; c < COLS; c++) {
      const s = c / (COLS - 1) - 0.5;
      const lat = s * width * taper;
      const cup = (s * s - 0.25) * 0.22 * width;       // center dips slightly back
      const q = (r * COLS + c) * 3;
      out[q] = lx * rad + wx * lat;
      out[q + 1] = ly * rad + wy * lat;
      out[q + 2] = zc + cup + twist * s * t;
    }
  }
  return out;
}

function petalGeometry(petal) {
  const { ROWS, COLS } = GRID;
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(petal.pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);

  const uv = new Float32Array(ROWS * COLS * 2);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = (r * COLS + c) * 2;
      uv[i] = c / (COLS - 1);
      uv[i + 1] = r / (ROWS - 1);
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const idx = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c, b = a + COLS;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function domeDisplace(circleGeo, radius, height) {
  const pos = circleGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const q = Math.sqrt(x * x + y * y) / radius;
    pos.setZ(i, height * (1 - q * q));
  }
  circleGeo.computeVertexNormals();
}

function leafGeometry() {
  const geo = new THREE.PlaneGeometry(0.55, 0.2, 8, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = x / 0.55 + 0.5;
    pos.setZ(i, Math.sin(u * Math.PI) * 0.05 - Math.abs(y) * 0.25);
    pos.setY(i, y * (0.4 + Math.sin(u * Math.PI) * 0.6));
  }
  geo.computeVertexNormals();
  return geo;
}

function gradientTexture(top, bottom) {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 512;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function radialTexture(inner, outer) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(256, 256, 40, 256, 256, 360);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
