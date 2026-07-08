// grass.js — instanced grass meadow with vertex-shader breeze sway.
// One draw call for ~6000 blades; bend weight comes from blade-local height
// (position.y in 0..1), so no UVs or extra attributes beyond a per-blade phase.

import * as THREE from 'three';

export function createGrass(scene, { count = 6000, inner = 0.4, outer = 8 } = {}) {
  // tapered blade, 3 bend segments, local y in 0..1
  const geo = new THREE.PlaneGeometry(0.045, 1, 1, 3);
  geo.translate(0, 0.5, 0);
  {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setX(i, pos.getX(i) * (1 - y * 0.82));       // taper to a near-point
      pos.setZ(i, y * y * 0.12);                       // natural forward arc
    }
    geo.computeVertexNormals();
  }

  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = Math.random() * Math.PI * 2;
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

  const uTime = { value: 0 };
  const uBreeze = { value: 0.35 };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uBreeze = uBreeze;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPhase;
        uniform float uTime;
        uniform float uBreeze;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float bend = position.y * position.y * uBreeze;
          float sway = sin(uTime * 1.6 + aPhase) + 0.55 * sin(uTime * 2.9 + aPhase * 1.7);
          float lull = 0.6 + 0.4 * sin(uTime * 0.5 + aPhase * 0.21);
          transformed.x += sway * lull * bend * 0.38;
          transformed.z += 0.6 * cos(uTime * 1.15 + aPhase * 2.3) * lull * bend * 0.38;
        }`);
  };

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const color = new THREE.Color();
  const base = new THREE.Color(0x5e7d3c);
  const tip = new THREE.Color(0x93b95e);
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(Math.random()) * (outer - inner) + inner;
    const a = Math.random() * Math.PI * 2;
    p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    e.set((Math.random() - 0.5) * 0.35, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.35);
    q.setFromEuler(e);
    const hgt = 0.15 + Math.random() * 0.26;
    s.set(0.7 + Math.random() * 0.7, hgt, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    color.lerpColors(base, tip, Math.random());
    color.offsetHSL((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.06);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);

  return {
    mesh,
    update(t, breeze) {
      uTime.value = t;
      uBreeze.value = breeze;
    },
  };
}
