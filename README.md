# Enhanced Hand-Tracking Instrument

A sophisticated webcam-based musical instrument that uses TensorFlow.js hand tracking to control dual synthesizers with advanced audio processing.

## 🎵 Features

### Core Functionality
- **Dual Hand Control**: Left and right hands control independent synthesizers
- **Real-time Hand Tracking**: Uses TensorFlow.js MediaPipe for precise hand detection
- **Position Smoothing**: Exponential smoothing eliminates jitter and sudden jumps
- **Dynamic Calibration**: Optional calibration system for personalized control ranges

### Audio Synthesis
- **Multiple Waveforms**:
  - Left Hand: Sine, Triangle, Sawtooth
  - Right Hand: Noise, Pulse, Organ (additive synthesis)
- **ADSR Envelopes**: Full Attack, Decay, Sustain, Release control for each hand
- **Frequency Mapping**: Y-axis controls pitch, with customizable ranges

### Built-in Effects
- **Reverb**: Convolution-based reverb with adjustable mix
- **Delay**: Feedback delay with velocity-sensitive timing
- **Dynamic Effects**: Hand movement velocity modulates effect parameters

### Visual Feedback
- **Edge Detection**: Real-time motion visualization
- **Hand Markers**: Color-coded position indicators (Cyan=Left, Magenta=Right)
- **Frequency Display**: Real-time frequency readouts
- **Calibration Guide**: Visual corner markers during calibration

## 🚀 Quick Start

1. Open `enhanced_hand_tracking_instrument.html` in a modern web browser
2. Grant camera permissions when prompted
3. Click **"Start Audio"** to initialize the audio system
4. Optionally click **"Calibrate"** for personalized control ranges
5. Move your hands in front of the camera to play!

## 🎛️ Controls

### Left Hand Instrument
- **Waveform**: Sine, Triangle, or Sawtooth
- **Pitch Range**: Customizable min/max frequencies (50-3000 Hz)
- **Volume**: Maximum gain control
- **ADSR Envelope**: Independent Attack, Decay, Sustain, Release controls

### Right Hand Instrument  
- **Waveform**: Noise, Pulse, or Organ
- **Pitch Range**: Customizable min/max frequencies (50-3000 Hz)
- **Volume**: Maximum gain control
- **ADSR Envelope**: Independent Attack, Decay, Sustain, Release controls

### Effects Section
- **Reverb**: 0-100% wet signal mix
- **Delay**: 0-100% delayed signal mix  
- **Smoothing**: 0-50% position smoothing factor

## 🎯 Calibration Process

The calibration system allows you to define custom control ranges:

1. Click **"Calibrate"**
2. Follow the on-screen instructions:
   - Move LEFT hand to TOP-LEFT corner (hold 2 seconds)
   - Move LEFT hand to BOTTOM-RIGHT corner (hold 2 seconds)
   - Move RIGHT hand to TOP-RIGHT corner (hold 2 seconds)
   - Move RIGHT hand to BOTTOM-LEFT corner (hold 2 seconds)
3. Click **"Skip Calibration"** to use default full-screen mapping

## 🎼 Playing Techniques

### Basic Control
- **Y-Axis (Vertical)**: Controls pitch frequency
  - Higher = Higher pitch
  - Lower = Lower pitch
- **Presence**: Hand detection triggers ADSR envelope
  - Enter frame = Attack phase
  - Exit frame = Release phase

### Advanced Techniques
- **Velocity Effects**: Fast hand movements increase delay time and reverb
- **Dual Hand Harmony**: Use both hands for rich harmonic textures
- **Envelope Shaping**: Adjust ADSR for different articulation styles
- **Waveform Switching**: Change timbres in real-time

## 🔧 Technical Details

### Dependencies
- **TensorFlow.js v3.21.0**: Core ML framework
- **HandPose Model v0.0.7**: Hand landmark detection
- **Web Audio API**: Real-time audio synthesis

### Audio Architecture
```
Hand Tracking → Position Smoothing → Frequency Mapping → Oscillators → ADSR → Effects → Output
                                                                           ↓
                                                                    Reverb + Delay
```

### Performance Optimizations
- **10 FPS Hand Detection**: Balanced accuracy and performance
- **Exponential Smoothing**: Reduces computational overhead
- **Efficient Audio Graph**: Optimized Web Audio API connections

## 🎨 Customization

### Waveform Development
Add custom waveforms by extending the `EnhancedOscillator` class:

```javascript
// Example: Custom waveform
if (this.type === 'custom') {
  const real = new Float32Array([0, 1, 0.5, 0.25, 0.125]);
  const imag = new Float32Array(real.length);
  const customWave = this.audioCtx.createPeriodicWave(real, imag);
  this.oscillator.setPeriodicWave(customWave);
}
```

### Effect Chains
Modify the audio routing in the `startAudio()` function to add new effects.

## 🎯 Performance Tips

1. **Lighting**: Ensure good lighting for optimal hand tracking
2. **Background**: Use contrasting backgrounds for better detection
3. **Distance**: Position hands 1-3 feet from camera
4. **Browser**: Use Chrome/Edge for best performance
5. **Hardware**: Modern devices with WebGL support recommended

## 🐛 Troubleshooting

### Common Issues
- **No Audio**: Check browser audio permissions and click "Start Audio"
- **Poor Tracking**: Improve lighting and camera position  
- **High Latency**: Reduce other running applications
- **Calibration Issues**: Use "Skip Calibration" for default mapping

### Debug Information
Open browser console to view detailed debug logs:
- Hand detection status
- Audio system initialization
- Calibration progress
- Performance metrics

## 🎵 Musical Applications

### Live Performance
- **Solo Instrument**: Expressive theremin-style performances
- **Ensemble**: Multiple users with separate devices
- **Electronic Music**: Integration with DAWs via audio routing

### Educational Use
- **Music Theory**: Visualize frequency relationships
- **Technology Demo**: Showcase AI and audio synthesis
- **Interactive Art**: Gesture-based sound installations

## 📱 Browser Compatibility

- ✅ Chrome 80+
- ✅ Firefox 75+ 
- ✅ Safari 14+
- ✅ Edge 80+
- ❌ Internet Explorer (not supported)

## 🔮 Future Enhancements

- **MIDI Output**: Control external synthesizers
- **Recording Capability**: Capture performances
- **Preset System**: Save/load custom configurations
- **Multi-Touch**: Support for tablet interfaces
- **3D Hand Tracking**: Z-axis control for additional parameters
- **Machine Learning**: Gesture recognition for mode switching

## 📄 License

This project is open source. Feel free to modify and distribute.

## 🤝 Contributing

Contributions welcome! Areas for improvement:
- Additional waveforms and synthesis methods
- Advanced effect processing
- Performance optimizations
- Mobile device support
- User interface enhancements

---

*Built with ❤️ using TensorFlow.js, Web Audio API, and modern web technologies* 