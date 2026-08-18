import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../synths/sound_catcher.html', import.meta.url), 'utf8');
const scriptStart = html.indexOf('<script>') + '<script>'.length;
const scriptEnd = html.lastIndexOf('</script>');
assert.ok(scriptStart >= '<script>'.length && scriptEnd > scriptStart, 'inline script is present');

const micSetupSource = html.slice(
    html.indexOf('async function setupMicrophone()'),
    html.indexOf('// First-time onboarding asks only for the protected tilt API.')
);
const beforeMicRequest = micSetupSource.slice(0,
    micSetupSource.indexOf('requestedStream = await navigator.mediaDevices.getUserMedia'));
assert.equal(beforeMicRequest.includes('await audioContext.resume()'), false,
    'REC does not wait on an unnecessary Web Audio resume before opening the mic');
assert.equal(beforeMicRequest.includes('await audioContext.suspend()'), false,
    'REC does not block microphone acquisition on an audio route transition');

function makeClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach(name => values.add(name)),
        remove: (...names) => names.forEach(name => values.delete(name)),
        toggle(name, force) {
            const enabled = force === undefined ? !values.has(name) : force;
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
        contains: name => values.has(name)
    };
}

function makeElement(id = '') {
    const listeners = new Map();
    const attributes = new Map();
    return {
        id,
        disabled: false,
        textContent: '',
        innerHTML: '',
        paused: true,
        attributes,
        style: { setProperty() {} },
        classList: makeClassList(),
        listeners,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        appendChild() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        play() { this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; },
        remove() {}
    };
}

const elementIds = [
    'record-btn', 'play-btn', 'reset-orientation-btn', 'nuke-btn',
    'request-controls-btn', 'permissions-overlay', 'modal-cancel',
    'layers-container', 'playback-indicator', 'layer-dots',
    'reverb-circles', 'yaw-indicator', 'filter-label', 'speed-label'
];
const elements = new Map(elementIds.map(id => [id, makeElement(id)]));
const tiltIcon = makeElement('tilt-icon');
tiltIcon.textContent = '⊙';
const tiltLabel = makeElement('tilt-label');
tiltLabel.textContent = 'TLT';
elements.get('reset-orientation-btn').querySelector = selector => {
    if (selector === '.button-icon') return tiltIcon;
    if (selector === '.button-label') return tiltLabel;
    return null;
};
const windowListeners = new Map();
const documentListeners = new Map();
const storageValues = new Map();

const documentStub = {
    hidden: false,
    body: makeElement('body'),
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createElementNS: () => makeElement(),
    addEventListener(type, handler) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(handler);
    }
};

const windowStub = {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: null,
    addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
    }
};

const context = vm.createContext({
    Blob,
    Math,
    console: { log() {}, warn() {}, error() {} },
    document: documentStub,
    window: windowStub,
    DeviceOrientationEvent: { requestPermission: async () => 'granted' },
    localStorage: {
        getItem: key => storageValues.get(key) ?? null,
        setItem: (key, value) => storageValues.set(key, String(value)),
        removeItem: key => storageValues.delete(key)
    },
    navigator: {},
    alert() {},
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    performance: { now: () => 0 }
});
windowStub.window = windowStub;

new vm.Script(html.slice(scriptStart, scriptEnd), { filename: 'sound_catcher.js' })
    .runInContext(context);

assert.equal(documentListeners.has('selectstart'), true,
    'native document selection is disabled across the instrument surface');

// Onboarding asks only for tilt. Microphone access is deferred to REC.
context.permissionSetupCalls = 0;
vm.runInContext(`
    setupMicrophone = async () => { permissionSetupCalls++; return true; };
    requestOrientationPermission = async () => true;
`, context);

const permissionClick = elements.get('request-controls-btn').listeners.get('click')[0];
await permissionClick();
assert.equal(context.permissionSetupCalls, 0,
    'onboarding does not open the microphone before the user records');
assert.equal(storageValues.get('soundcatcher:onboarded:v1'), '1');
assert.equal(elements.get('permissions-overlay').classList.contains('active'), false);

elements.get('permissions-overlay').classList.add('active');
vm.runInContext(`
    isInitialized = false;
    testBootstrapResult = bootstrapPermissionFlow();
    testInitializedAfterReturn = isInitialized;
`, context);
assert.equal(context.testBootstrapResult, 'returning');
assert.equal(context.testInitializedAfterReturn, true);
assert.equal(elements.get('permissions-overlay').classList.contains('active'), false,
    'returning users on the same origin skip the onboarding overlay');
assert.equal(context.permissionSetupCalls, 0);

context.captureEvents = [];
vm.runInContext(`
    isInitialized = true;
    isPlaying = true;
    stopPlayback = async () => { captureEvents.push('stop-playback'); isPlaying = false; };
    pauseSilentLoop = () => { captureEvents.push('pause-silent-loop'); };
    startRecording = async () => { captureEvents.push('start-recording'); return true; };
`, context);
const recordClick = elements.get('record-btn').listeners.get('click')[0];
const recordPointerDown = elements.get('record-btn').listeners.get('pointerdown')[0];
context.pointerMicCalls = 0;
vm.runInContext(`
    isInitialized = true;
    isPlaying = false;
    isStartingRecording = false;
    isProcessingRecording = false;
    mediaRecorder = null;
    setupMicrophone = async () => { pointerMicCalls++; return true; };
`, context);
recordPointerDown({ isPrimary: true, pointerType: 'touch', button: 0 });
await Promise.resolve();
assert.equal(context.pointerMicCalls, 1,
    'REC begins opening the microphone on pointerdown');
vm.runInContext('isPlaying = true;', context);

await recordClick();
assert.deepEqual([...context.captureEvents], [
    'stop-playback', 'pause-silent-loop', 'start-recording'
], 'speaker playback stops before microphone capture begins');

context.captureEvents = [];
vm.runInContext(`
    isPlaying = false;
    unlockSilentMode = () => { captureEvents.push('prime-output'); };
    startRecording = async () => { captureEvents.push('request-mic-on-rec'); return true; };
`, context);
await recordClick();
assert.deepEqual([...context.captureEvents], ['prime-output', 'request-mic-on-rec'],
    'returning users defer microphone access until their first REC gesture');

function makeAudioParam(value = 0) {
    return {
        value,
        setValueAtTime(next) { this.value = next; },
        linearRampToValueAtTime(next) { this.value = next; },
        setTargetAtTime(next) { this.value = next; }
    };
}

function makeAudioNode(kind = 'node') {
    return {
        kind,
        outputs: [],
        gain: makeAudioParam(),
        frequency: makeAudioParam(),
        Q: makeAudioParam(),
        connect(target) { this.outputs.push(target); return target; },
        disconnect() { this.outputs = []; }
    };
}

let grainsCreated = 0;
const fakeAudioContext = {
    currentTime: 10,
    createBufferSource() {
        grainsCreated++;
        return { ...makeAudioNode('source'), start() {} };
    },
    createGain: () => makeAudioNode('gain'),
    createBiquadFilter: () => makeAudioNode('filter'),
    createConvolver: () => makeAudioNode('convolver')
};
context.testAudioContext = fakeAudioContext;
context.testMasterGain = makeAudioNode('master');
context.testLayerGain = makeAudioNode('layer-gain');
context.testSharedConvolver = makeAudioNode('shared-convolver');
context.testReverbWetGain = makeAudioNode('reverb-wet');
context.testSharedConvolver.connect(context.testReverbWetGain);
vm.runInContext(`
    audioContext = testAudioContext;
    masterGain = testMasterGain;
    reverbConvolver = testSharedConvolver;
    reverbWetGain = testReverbWetGain;
`, context);

function scheduleAtSpeed(speed, nextGrainTime = fakeAudioContext.currentTime) {
    grainsCreated = 0;
    context.testSpeed = speed;
    context.testNextGrainTime = nextGrainTime;
    vm.runInContext(`
        orientationData.speed = testSpeed;
        isPlaying = true;
        testScheduledLayer = {
            audioBuffer: { duration: 4 },
            selection: { start: 0, end: 1 },
            gainNode: testLayerGain,
            playbackPosition: 0,
            nextGrainTime: testNextGrainTime,
            grainScheduleId: null
        };
        scheduleGrains(testScheduledLayer);
        testPlaybackPosition = testScheduledLayer.playbackPosition;
    `, context);
    return { count: grainsCreated, position: context.testPlaybackPosition };
}

const slow = scheduleAtSpeed(0.05);
const normal = scheduleAtSpeed(1);
const fast = scheduleAtSpeed(20);
assert.ok(slow.count < normal.count && normal.count < fast.count,
    'tilt retains the original sparse-to-dense grain character');

context.testLayerA = { audioBuffer: { duration: 4 }, volume: 0.4 };
context.testLayerB = { audioBuffer: { duration: 4 }, volume: 0.4 };
vm.runInContext(`
    isPlaying = false;
    scheduleLayerPlayback(testLayerA);
    scheduleLayerPlayback(testLayerB);
    testMix = getReverbMix(0.37);
`, context);
assert.ok(context.testLayerA.filterNode.outputs.includes(context.testSharedConvolver));
assert.ok(context.testLayerB.filterNode.outputs.includes(context.testSharedConvolver));
assert.equal(context.testSharedConvolver.outputs.length, 1,
    'shared reverb has exactly one wet output as layers are added');
assert.ok(Math.abs(
    (context.testMix.dry ** 2 + context.testMix.wet ** 2) - 1
) < 1e-12, 'reverb uses a constant-power crossfade');

context.navigator.audioSession = { type: 'auto' };
vm.runInContext("setAudioSessionType('playback');", context);
assert.equal(context.navigator.audioSession.type, 'playback',
    'iOS audio session returns to playback after microphone release');

vm.runInContext(`
    orientationData = {
        speed: 3.25,
        reverb: 0.42,
        filterType: 'highpass',
        filterFreq: 2400
    };
    setTiltLocked(true);
    handleOrientation({ beta: 120, gamma: 70, alpha: 180 });
    testLockedTilt = { ...orientationData };
`, context);
assert.deepEqual({ ...context.testLockedTilt }, {
    speed: 3.25,
    reverb: 0.42,
    filterType: 'highpass',
    filterFreq: 2400
}, 'tilt lock freezes all three tilt-controlled effects');
assert.equal(tiltIcon.textContent, '▣');
assert.equal(tiltLabel.textContent, 'LCK');
assert.equal(elements.get('reset-orientation-btn').getAttribute('aria-pressed'), 'true');
assert.equal(elements.get('reset-orientation-btn').getAttribute('aria-label'),
    'Tilt locked; tap to unlock');
assert.equal(elements.get('playback-indicator').classList.contains('tilt-locked'), true,
    'the compass receives the visible locked state');
const tiltTouchStart = elements.get('reset-orientation-btn').listeners.get('touchstart')[0];
const tiltTouchEnd = elements.get('reset-orientation-btn').listeners.get('touchend')[0];
tiltTouchStart({ preventDefault() {} });
tiltTouchEnd({ preventDefault() {} });
assert.equal(tiltIcon.textContent, '⊙');
assert.equal(tiltLabel.textContent, 'TLT');
assert.equal(elements.get('playback-indicator').classList.contains('tilt-locked'), false);
assert.equal(elements.get('reset-orientation-btn').getAttribute('aria-pressed'), 'false',
    'a normal tap immediately unlocks tilt');
assert.equal(elements.get('reset-orientation-btn').listeners.has('touchstart'), true,
    'tilt uses the same native touch hold path as clear on iOS');
assert.equal(elements.get('reset-orientation-btn').listeners.has('pointerdown'), false,
    'tilt does not leave its long press to Safari pointer selection behavior');

vm.runInContext(`
    testWaveformLevels = {
        silence: amplitudeToDisplayLevel(0),
        minus20db: amplitudeToDisplayLevel(0.1),
        fullScale: amplitudeToDisplayLevel(1)
    };
`, context);
assert.equal(context.testWaveformLevels.silence, 0);
assert.ok(Math.abs(context.testWaveformLevels.minus20db - (2 / 3)) < 1e-12,
    'a -20 dBFS recording is legible on the logarithmic waveform');
assert.equal(context.testWaveformLevels.fullScale, 1);

vm.runInContext(`
    testOutputGains = {
        muted: sliderToGain(0),
        unity: sliderToGain(80),
        maximum: sliderToGain(100)
    };
`, context);
assert.equal(context.testOutputGains.muted, 0);
assert.equal(context.testOutputGains.unity, 1,
    'the default 80 position is true unity gain');
assert.ok(Math.abs(context.testOutputGains.maximum - Math.pow(10, 0.6)) < 1e-12,
    'the top of the fader provides 12 dB of make-up gain');

function makeStyleRecorder() {
    const values = new Map();
    return {
        values,
        setProperty(name, value) { values.set(name, value); }
    };
}

const identityNumberStyle = makeStyleRecorder();
const identityStartStyle = makeStyleRecorder();
const identityEndStyle = makeStyleRecorder();
context.testIdentityLayer = {
    id: 44,
    numberEl: { style: identityNumberStyle },
    handleStartEl: { style: identityStartStyle },
    handleEndEl: { style: identityEndStyle }
};
vm.runInContext('updateLayerIdentity(testIdentityLayer, 2);', context);
assert.equal(context.testIdentityLayer.colorIndex, 2);
assert.equal(identityNumberStyle.values.get('--layer-fill'), context.testIdentityLayer.color,
    'renumbering a surviving track also recolors its gain fill');
assert.equal(identityStartStyle.values.get('--handle-color'), context.testIdentityLayer.color);
assert.equal(identityEndStyle.values.get('--handle-color'), context.testIdentityLayer.color);

const fader = makeElement('test-fader');
fader.getBoundingClientRect = () => ({ top: 0, height: 100 });
fader.setPointerCapture = () => {};
fader.hasPointerCapture = () => false;
context.testFader = fader;
context.testFaderLayer = { volumeSlider: 80, volume: 0, gainNode: null };
vm.runInContext('attachNumberGainGesture(testFaderLayer, testFader);', context);
const faderPointerDown = fader.listeners.get('pointerdown')[0];
faderPointerDown({ pointerId: 7, clientY: 25, preventDefault() {} });
assert.equal(context.testFaderLayer.volumeSlider, 75,
    'gain fader accepts pointer input used by mouse, pen, and touch');
assert.equal(fader.listeners.has('touchstart'), false,
    'gain fader has one cross-device input path');

context.backgroundEvents = [];
context.cancelAnimationFrame = id => context.backgroundEvents.push(`cancel-animation:${id}`);
context.clearTimeout = id => context.backgroundEvents.push(`clear-timer:${id}`);
vm.runInContext(`
    layers = [];
    mediaRecorder = null;
    animationFrameId = 23;
    orientationPermissionCheckTimer = 91;
    audioContext = { state: 'suspended' };
    releaseMicrophone = () => { backgroundEvents.push('release-mic'); };
    pauseSilentLoop = () => { backgroundEvents.push('pause-helper'); };
`, context);
await vm.runInContext('pauseEverything();', context);
assert.deepEqual([...context.backgroundEvents], [
    'clear-timer:91', 'cancel-animation:23', 'release-mic', 'pause-helper'
], 'phone lock explicitly stops timers, animation, microphone, and helper audio');

console.log('Sound Catcher audio lifecycle tests: ok');
