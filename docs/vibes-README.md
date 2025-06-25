# Vibes - AI-Powered Hand-Tracking Theremins

A collection of sophisticated webcam-based musical instruments that use TensorFlow.js hand tracking to control dual synthesizers with advanced audio processing.

## 🎵 Available Versions

### [Enhanced Theremin v5 Complete](enhanced_theremin_gestures_v5_complete.html) - **Latest**
The most advanced version with:
- **Mobile-Friendly Design** - Collapsible interface that auto-hides on mobile
- **Fixed Layer Creation** - Proper debouncing prevents excessive sound layer bugs
- **Face Mask Effect** - White dot overlay on face landmarks for visual appeal
- **Head-out-of-frame Silence** - Safety feature stops all sounds when head leaves frame
- **Musical Scale System** - Major, Minor, Pentatonic, Chromatic, and Colundi scales
- **Advanced Gesture Controls** - Open hand, fist, peace sign gestures
- **Sound Layer Management** - Multiple simultaneous sound layers with proper control
- **Edge Detection Effects** - Real-time motion visualization
- **Dual-Hand Synthesis** - Independent left/right hand instruments

### [Enhanced Theremin v4 Psychedelic](enhanced_theremin_gestures_v4_psychedelic.html)
Previous version featuring:
- Psychedelic visual effects
- Mouth tracking and vowel detection (removed in v5)
- Basic gesture recognition
- LFO modulation and white noise synthesis

## 🚀 Quick Start

1. **Open either HTML file** in a modern web browser (Chrome recommended)
2. **Grant camera permissions** when prompted
3. **Click "Start Audio & Effects"** to initialize the audio system
4. **Move your hands** in front of the camera to play!

## 🎛️ Controls

### Gesture-Based Playing
- **Open Hand**: Create new sound based on finger count and Y position
- **✊ Fist**: Freeze/sustain current sound
- **✌️ Peace Sign**: Deliberately create new sound layer
- **Head Out of Frame**: Emergency silence all sounds

### Musical Features
- **Y-Axis Movement**: Controls pitch frequency
- **Hand Distance**: Controls volume (closer = louder)
- **Musical Scales**: Automatic quantization to selected scale
- **Multi-layering**: Create complex harmonies with multiple gesture layers

## 🔧 Technical Features

- **TensorFlow.js HandPose**: Real-time hand landmark detection
- **ML5.js FaceMesh**: Face detection for mask effects and silence control
- **Web Audio API**: High-quality real-time audio synthesis
- **Responsive Design**: Works on desktop and mobile devices
- **Debug Logging**: Comprehensive console output for troubleshooting

## 🎯 Browser Compatibility

- ✅ Chrome 80+ (Recommended)
- ✅ Firefox 75+
- ✅ Safari 14+
- ✅ Edge 80+

## 🤝 Contributing

This is an open-source project under GPL-3.0 license. Contributions welcome!

## 📄 License

GPL-3.0 - See [LICENSE](LICENSE) file for details.

---

*Built with ❤️ using TensorFlow.js, ML5.js, Web Audio API, and modern web technologies*