# Project Structure - Vibes Audio Synthesis Collection

This document outlines the structure and organization of the Vibes audio synthesis collection.

## 📁 Directory Structure

```
vibes/
├── synths/                                   # Audio synthesis instruments
│   ├── visual_eno_loops_glow.html           # Visual ambient composer (desktop)
│   ├── visual_eno_loops_glow_mobile.html    # Mobile-optimized ambient composer
│   ├── visual_eno_loops_final.html          # Another ambient loop variant
│   ├── enhanced_theremin_gestures_v4_psychedelic.html
│   ├── enhanced_theremin_gestures_v5_complete.html
│   ├── theremin_dual_sine_sorted.html       # Dual sine theremin
│   ├── fm_synth_v1.html                     # FM synthesis experiments
│   ├── fm_synth_v2.html
│   ├── fm_synth_v3.html                     # Complex FM with Philip Glass features (buggy)
│   ├── glass_conductor_v4.html              # NEW: Stable Philip Glass conductor
│   ├── glass_minimalist_composer.html       # Click-based Glass composer
│   ├── hrv_monitor.html                     # Heart rate variability monitor
│   └── index.html                           # Synths directory index
├── tools/                                   # Python utilities
│   ├── prompt.py                            # Prompt generation tool
│   └── userinput.py                         # User input utilities
├── docs/                                    # Documentation
│   ├── project_structure.md                # This file
│   ├── user_tasks.log                       # Task history
│   └── vibes-README.md                      # Extended documentation
├── scripts/                                 # Build scripts
│   └── generate-file-list.js               # Auto-discovery system
├── index.html                               # Main landing page
├── files.json                              # Auto-generated file listing
├── package.json                            # Node.js dependencies
└── README.md                               # Project overview
```

## 📄 File Descriptions

### `synths/visual_eno_loops_glow_mobile.html`
**Mobile-optimized ambient composer** - Complete standalone HTML application with full mobile support:

#### Mobile Enhancements
- **Viewport Meta Tag**: Proper mobile viewport configuration
- **High-DPI Canvas**: `window.devicePixelRatio` awareness for crisp Retina displays
- **Pointer Events**: Touch and mouse support via `pointerdown`/`pointermove`/`pointerup`
- **Web Audio Mobile**: Handles `audioCtx.state === 'suspended'` and user gesture requirements
- **Responsive Design**: 44×44px minimum tap targets, adaptive layouts
- **Touch-Friendly UI**: Enhanced sliders, buttons, and interactive elements
- **HTTPS Detection**: Warns users about Web Audio limitations over HTTP

#### Core Features
- **Five Draggable Loops**: Touch/drag colored circles to change pitch
- **Adjustable Timing**: Range sliders for loop interval control (1-15 seconds)
- **Real-time Audio**: Web Audio API with sine wave oscillators
- **Visual Feedback**: Glowing circles when loops are playing
- **C Major Scale**: Quantized frequency mapping across screen width
- **Responsive Layout**: Adapts to screen size and orientation changes

### `synths/visual_eno_loops_glow.html`
**Desktop ambient composer** - Original version optimized for mouse interaction:

#### HTML Structure
- **Controls Panel**: UI for all instrument parameters
- **Calibration Overlay**: Modal interface for calibration process
- **Video Element**: Hidden webcam feed
- **Canvas Elements**: Video display and visual effects overlay

#### CSS Styling
- **Dark Theme**: Black background with white text
- **Responsive Layout**: Adapts to different screen sizes
- **Modern UI**: Styled buttons, sliders, and form elements
- **Overlay System**: Calibration modal with semi-transparent background

#### JavaScript Modules

##### Core Systems
```javascript
// Hand Tracking
- TensorFlow.js integration
- HandPose model loading
- Real-time hand detection
- Position smoothing algorithms

// Audio Engine  
- Web Audio API setup
- Master gain control
- Effect chain routing
- Dynamic parameter updates

// Calibration System
- Step-by-step guidance
- Position recording
- Range mapping
- Visual feedback
```

##### Classes and Components
```javascript
// ADSREnvelope Class
- Attack, Decay, Sustain, Release control
- Real-time parameter adjustment
- Envelope triggering and release

// EnhancedOscillator Class  
- Multiple waveform support
- Dynamic type switching
- Frequency control
- Audio routing

// Position Smoothing
- Exponential smoothing functions
- Velocity calculation
- Jitter elimination
```

##### Audio Features
```javascript
// Synthesis
- Sine, Triangle, Sawtooth waves (Left Hand)
- Noise, Pulse, Organ sounds (Right Hand)
- Custom waveform generation
- Real-time frequency mapping

// Effects Processing
- Convolution reverb
- Feedback delay
- Velocity-sensitive modulation
- Wet/dry mixing
```

##### Visual Systems
```javascript
// Video Processing
- Camera feed mirroring
- Edge detection algorithms
- Motion visualization
- Real-time canvas rendering

// UI Feedback
- Hand position markers
- Frequency displays
- Calibration guides
- Visual effect overlays
```

### `glass_conductor_v4.html`
**NEW: Stable Philip Glass Conductor** - Simplified gesture-based conducting interface:

#### Stability Improvements over v3
- **Fixed Variable Declarations**: All missing constants and helpers properly defined
- **Stable Hand Detection**: Reduced detection frequency (150ms) prevents jitter
- **Memory Management**: Proper audio node cleanup prevents memory leaks  
- **Single Timer Pattern**: Eliminates race conditions from multiple setInterval calls
- **Simplified Gesture Logic**: Stable left/right hand assignment based on position

#### Philip Glass Alignment Features
- **Minimal UI**: Only 4 essential controls (scale, tempo, start, clear)
- **Conducting Gestures**: 
  - Left Hand: Harmonic progression (vertical = root note)
  - Right Hand: Additive process control (vertical = complexity)
  - Distance: Dynamic volume control
- **Glass Patterns**: 
  - Authentic additive processes (1-5 notes)
  - Polyrhythmic cycles (different lengths per pattern)
  - Modal scales (Dorian, Mixolydian, etc.)
  - Detached articulation (classic Glass style)
- **Musical Continuity**: Patterns sustain and layer naturally
- **Live Status Display**: Real-time pattern and complexity feedback

#### Technical Architecture
```javascript
// Core Classes
GlassPattern Class          // Stable pattern generation
- Additive complexity control
- Polyrhythmic cycling
- Clean start/stop methods
- Memory-safe audio nodes

// Audio System
Minimal Web Audio setup     // No complex FM synthesis
- Single master gain node
- Pure sine waves only
- Quick attack/decay envelopes
- Automatic audio context handling

// Hand Processing  
Simplified gesture detection
- Position-based hand assignment (more stable)
- Volume from hand span distance
- Reduced sensitivity prevents jitter
- 500ms stability delay for gesture changes
```

### `fm_synth_v3.html`
**Complex FM with Philip Glass features (BUGGY)** - Advanced but unstable implementation:
- Multiple missing variable declarations cause crashes
- Race conditions between arpeggio timers
- Complex finger counting creates instability  
- Over-engineered UI distracts from conducting
- Memory leaks from improper audio node cleanup

*Note: Use glass_conductor_v4.html instead for stable Glass conducting*

### `theremin_dual_sine_sorted.html` 
**Legacy version** - Original dual-sine theremin implementation:
- Basic hand tracking
- Simple oscillator control
- LFO modulation
- Edge detection visualization

*Note: Kept for reference and comparison*

### `README.md`
**Project documentation** including:
- Feature overview
- Usage instructions  
- Technical specifications
- Troubleshooting guide
- Future enhancement plans

### `project_structure.md`
**This file** - Comprehensive project organization documentation

## 🎯 Key Implementation Details

### Dependencies
```javascript
// External Libraries
TensorFlow.js v3.21.0        // Machine learning framework
HandPose Model v0.0.7        // Hand landmark detection

// Browser APIs
Web Audio API                // Real-time audio synthesis
MediaDevices API             // Camera access
Canvas API                   // Visual rendering
```

### Audio Architecture
```
Input: Hand Tracking Data
    ↓
Position Smoothing (Exponential)
    ↓
Frequency Mapping (Y-axis → Hz)
    ↓
Oscillator Generation (L/R Independent)
    ↓
ADSR Envelope Processing
    ↓
Effects Chain (Reverb + Delay)
    ↓
Master Gain → Audio Output
```

### Performance Considerations
- **Hand Detection**: 10 FPS (100ms intervals) for optimal performance
- **Audio Processing**: 44.1kHz sample rate with low-latency buffer
- **Position Smoothing**: Configurable alpha values (0-0.5)
- **Canvas Rendering**: RequestAnimationFrame for smooth visuals

## 🔧 Configuration System

### Control Parameters
```javascript
// Left Hand Instrument
leftMinPitch: 50-1000 Hz
leftMaxPitch: 500-3000 Hz  
leftMaxGain: 0-1.0
leftWaveform: sine|triangle|sawtooth
leftADSR: attack|decay|sustain|release

// Right Hand Instrument  
rightMinPitch: 50-1000 Hz
rightMaxPitch: 500-3000 Hz
rightMaxGain: 0-1.0
rightWaveform: noise|pulse|organ
rightADSR: attack|decay|sustain|release

// Effects
reverbMix: 0-1.0
delayMix: 0-1.0
smoothing: 0-0.5
```

### Calibration Data
```javascript
calibrationData: {
  leftMin: {x, y},      // Left hand minimum bounds
  leftMax: {x, y},      // Left hand maximum bounds  
  rightMin: {x, y},     // Right hand minimum bounds
  rightMax: {x, y},     // Right hand maximum bounds
  isCalibrated: boolean // Calibration status
}
```

## 🎨 Visual Design System

### Color Scheme
```css
Background: #000000 (Black)
Text: #FFFFFF (White)
Left Hand: #00FFFF (Cyan) 
Right Hand: #FF00FF (Magenta)
UI Elements: Semi-transparent overlays
Effects: HSL-based dynamic colors
```

### UI Components
- **Buttons**: Rounded corners, hover effects
- **Sliders**: Full-width range inputs
- **Sections**: Bordered containers with hierarchy
- **Overlays**: Modal dialogs with backdrop blur

## 🚀 Development Workflow

### Code Organization
1. **HTML Structure**: Semantic markup for accessibility
2. **CSS Styling**: Modular classes with clear naming
3. **JavaScript**: IIFE pattern for scope isolation
4. **Comments**: Comprehensive debug logging system

### Debug Features
```javascript
debugLog() function provides:
- System initialization status
- Hand detection performance
- Audio system state
- Calibration progress
- Error handling
```

## 🔮 Extension Points

### Adding New Waveforms
Extend the `EnhancedOscillator` class with custom waveform generation:
```javascript
createOscillator() {
  // Add new waveform type handling
  if (this.type === 'newWaveform') {
    // Custom implementation
  }
}
```

### Additional Effects
Modify the audio routing in `startAudio()` to insert new effect nodes:
```javascript
// Insert new effects in the chain
oscillator → newEffect → existingEffects → output
```

### Enhanced Calibration
Extend calibration system for additional parameters:
- Z-axis depth sensing
- Gesture recognition
- Multi-point calibration
- Automatic range detection

## 📊 Performance Metrics

### Target Performance
- **Latency**: <50ms audio latency
- **Frame Rate**: 60fps visual rendering  
- **Detection**: 10fps hand tracking
- **Memory**: <100MB total usage

### Optimization Strategies
- Efficient canvas operations
- Audio buffer management
- Memory leak prevention
- CPU usage monitoring

---

*Last Updated: Current session - Enhanced features implementation* 