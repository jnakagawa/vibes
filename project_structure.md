# Project Structure - Enhanced Hand-Tracking Instrument

This document outlines the structure and organization of the Enhanced Hand-Tracking Instrument project.

## 📁 Directory Structure

```
ar toy/
├── enhanced_hand_tracking_instrument.html    # Main application file
├── theremin_dual_sine_sorted.html           # Original version (legacy)
├── README.md                                 # Project documentation
└── project_structure.md                     # This file
```

## 📄 File Descriptions

### `enhanced_hand_tracking_instrument.html`
**Main application file** - Complete standalone HTML application containing:

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