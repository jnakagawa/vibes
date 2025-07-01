# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vibes is an interactive audio synthesis collection featuring hand-tracked instruments built with Web Audio API and TensorFlow.js. The project consists of standalone HTML files that combine machine learning, audio synthesis, and visual feedback for browser-based musical instruments.

## Common Commands

### Development
- `npm run build` - Generate files.json directory listing
- `npm run dev` - Build and start local server on port 8000
- `npm run serve` - Start Python HTTP server on port 8000
- `npm run serve-alt` - Start http-server (Node.js) on port 8000
- `npm run serve-node` - Start serve (Node.js) on port 8000

### File Discovery System
The project uses `scripts/generate-file-list.js` to create a dynamic file listing (`files.json`) that powers the main navigation interface. Run the build command after adding new files to update the navigation.

## Architecture

### Core Structure
- **Standalone Instruments**: Each synthesizer is a complete HTML file with embedded CSS/JavaScript
- **Auto-Discovery**: Main index.html dynamically loads available instruments from files.json
- **No External Dependencies**: All instruments include their dependencies inline for portability

### Key Technologies
- **TensorFlow.js v3.21.0** + HandPose Model v0.0.7 for hand tracking
- **Web Audio API** for real-time synthesis and effects processing
- **Canvas API** for visual feedback and hand position rendering
- **MediaDevices API** for camera access

### Audio Architecture Pattern
All instruments follow this signal flow:
```
Hand Tracking → Position Smoothing → Frequency Mapping → Oscillator Generation → ADSR Envelope → Effects Chain → Master Output
```

### Key Classes and Patterns
- **ADSREnvelope Class**: Attack/Decay/Sustain/Release envelope control
- **EnhancedOscillator Class**: Multi-waveform oscillator with dynamic switching
- **Calibration System**: Step-by-step hand position range mapping
- **Position Smoothing**: Exponential smoothing to reduce jitter (alpha values 0-0.5)

## File Organization

### `/synths/` - Interactive Instruments
- **Stable Instruments**: `glass_conductor_v4.html`, `visual_eno_loops_glow_mobile.html`
- **Legacy/Experimental**: Older versions kept for reference (v1-v3 variants)
- **Performance Target**: 10fps hand detection (100ms intervals), <50ms audio latency

### Key Implementation Files
- `glass_conductor_v4.html` - Stable Philip Glass conducting interface with gesture-based control
- `visual_eno_loops_glow_mobile.html` - Mobile-optimized ambient composer with touch support
- `enhanced_theremin_gestures_v5_complete.html` - Advanced dual-hand theremin
- `theremin_dual_sine_sorted.html` - Original reference implementation

### Mobile Considerations
Mobile instruments include:
- Proper viewport meta tags for responsive design
- devicePixelRatio awareness for high-DPI displays
- Pointer event handling (touch + mouse)
- Audio context suspension handling for mobile browsers
- 44×44px minimum tap targets

## Development Guidelines

### Adding New Instruments
1. Create self-contained HTML file in `/synths/`
2. Include all dependencies inline (no external CDN links)
3. Follow the established audio architecture pattern
4. Include proper error handling and debug logging
5. Run `npm run build` to update file discovery

### Hand Tracking Implementation
- Use 100ms intervals (10fps) for optimal performance vs accuracy
- Implement exponential smoothing for position data
- Include calibration system for user-specific ranges
- Handle missing hand detection gracefully

### Audio Performance
- Target 44.1kHz sample rate with low-latency buffers
- Clean up audio nodes properly to prevent memory leaks
- Use single timer patterns to avoid race conditions
- Implement proper gain staging and master volume control

### Debugging
All instruments include comprehensive debug logging via `debugLog()` functions that track:
- System initialization status
- Hand detection performance
- Audio system state
- Calibration progress
- Error conditions

## Browser Compatibility

Instruments require modern browsers supporting:
- Web Audio API
- MediaDevices API (camera access)
- TensorFlow.js WebGL backend
- ES6+ JavaScript features

HTTPS is required for camera access in production environments.