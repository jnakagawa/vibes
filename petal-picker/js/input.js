// input.js — unified picking input: mouse/touch pointers + MediaPipe hand
// tracking. Emits press / move / release with NDC coordinates; hand pointers
// also report "pull" (hand moving toward the camera after the pinch started).

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class InputManager {
  constructor(canvas, cursorsEl) {
    this.canvas = canvas;
    this.cursorsEl = cursorsEl;
    this.handlers = { press: () => {}, move: () => {}, release: () => {} };
    this.mouseNdc = { x: 0, y: 0 };
    this.hands = new Map();       // id -> hand state
    this.cursorDivs = new Map();
    this.landmarker = null;
    this.video = null;
    this.overlay = null;
    this.stream = null;
    this.lastVideoTime = -1;

    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      const ndc = this.toNdc(e.clientX, e.clientY);
      this.mouseNdc = ndc;
      this.handlers.press('ptr' + e.pointerId, ndc);
    });
    canvas.addEventListener('pointermove', (e) => {
      const ndc = this.toNdc(e.clientX, e.clientY);
      this.mouseNdc = ndc;
      this.handlers.move('ptr' + e.pointerId, ndc, 0);
    });
    const up = (e) => this.handlers.release('ptr' + e.pointerId);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  toNdc(cx, cy) {
    return {
      x: (cx / window.innerWidth) * 2 - 1,
      y: -(cy / window.innerHeight) * 2 + 1,
    };
  }

  get handsActive() { return !!this.stream; }

  async startHands(video, overlay) {
    if (this.stream) return;
    this.video = video;
    this.overlay = overlay;
    // camera first: fail fast if the user denies permission
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.stopHands();
      if (this.onHandsLost) this.onHandsLost();
    });
    video.srcObject = this.stream;
    await video.play();

    if (!this.landmarker) {
      const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
        numHands: 2,
        runningMode: 'VIDEO',
      });
    }
  }

  stopHands() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    for (const id of [...this.hands.keys()]) this.dropHand(id);
    if (this.overlay) {
      const ctx = this.overlay.getContext('2d');
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
  }

  dropHand(id) {
    const hand = this.hands.get(id);
    if (hand && hand.pinching) this.handlers.release(id);
    this.hands.delete(id);
    const div = this.cursorDivs.get(id);
    if (div) { div.remove(); this.cursorDivs.delete(id); }
  }

  update(nowMs) {
    if (!this.landmarker || !this.stream || !this.video || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let results;
    try {
      results = this.landmarker.detectForVideo(this.video, nowMs);
    } catch { return; }

    const seen = new Set();
    const octx = this.overlay ? this.overlay.getContext('2d') : null;
    if (octx) {
      if (this.overlay.width !== this.overlay.clientWidth) {
        this.overlay.width = this.overlay.clientWidth;
        this.overlay.height = this.overlay.clientHeight;
      }
      octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    (results.landmarks || []).forEach((lm, i) => {
      const handed = results.handedness?.[i]?.[0]?.categoryName || String(i);
      const id = 'hand-' + handed;
      seen.add(id);

      const thumb = lm[4], index = lm[8];
      const rawX = (thumb.x + index.x) / 2;
      const rawY = (thumb.y + index.y) / 2;
      const scale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1e-4;
      const pinchRatio = Math.hypot(thumb.x - index.x, thumb.y - index.y) / scale;

      let hand = this.hands.get(id);
      if (!hand) {
        hand = { x: rawX, y: rawY, pinching: false, scale0: scale };
        this.hands.set(id, hand);
      }
      // smooth cursor
      hand.x += (rawX - hand.x) * 0.45;
      hand.y += (rawY - hand.y) * 0.45;

      const ndc = { x: (1 - hand.x) * 2 - 1, y: -(hand.y * 2 - 1) };  // mirrored

      const wasPinching = hand.pinching;
      if (!wasPinching && pinchRatio < 0.32) hand.pinching = true;
      else if (wasPinching && pinchRatio > 0.46) hand.pinching = false;

      if (hand.pinching && !wasPinching) {
        hand.scale0 = scale;
        this.handlers.press(id, ndc);
      } else if (!hand.pinching && wasPinching) {
        this.handlers.release(id);
      }
      const pull = hand.pinching ? (scale / hand.scale0 - 1) : 0;
      this.handlers.move(id, ndc, pull);

      this.updateCursor(id, ndc, hand.pinching);

      if (octx) {
        const w = this.overlay.width, h = this.overlay.height;
        octx.strokeStyle = octx.fillStyle = hand.pinching ? '#e8a33c' : '#fffdf5';
        octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(thumb.x * w, thumb.y * h);
        octx.lineTo(index.x * w, index.y * h);
        octx.stroke();
        for (const p of [thumb, index]) {
          octx.beginPath();
          octx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
          octx.fill();
        }
      }
    });

    for (const id of [...this.hands.keys()]) {
      if (!seen.has(id)) this.dropHand(id);
    }
  }

  updateCursor(id, ndc, pinching) {
    let div = this.cursorDivs.get(id);
    if (!div) {
      div = document.createElement('div');
      div.className = 'cursor';
      this.cursorsEl.appendChild(div);
      this.cursorDivs.set(id, div);
    }
    const px = (ndc.x + 1) / 2 * window.innerWidth;
    const py = (1 - ndc.y) / 2 * window.innerHeight;
    div.style.left = px + 'px';
    div.style.top = py + 'px';
    div.classList.toggle('pinch', pinching);
  }
}
