# Social Beating - iOS Native App

Native iOS app using Ultra-Wideband (UWB) for precise proximity detection in the Social Beating sound installation.

## Requirements

- **iPhone 11 or newer** (requires U1 chip for UWB)
- **iOS 16+**
- **Xcode 15+**

## Setup

1. Open Xcode
2. Create new project: **File → New → Project → iOS → App**
3. Settings:
   - Product Name: `SocialBeating`
   - Interface: `SwiftUI`
   - Language: `Swift`
4. Copy the files from `SocialBeating/` into your project:
   - `SocialBeatingApp.swift` → Replace existing
   - `ContentView.swift` → Replace existing
   - `social_beating.html` → Add to project (check "Copy items if needed")
   - `Info.plist` → Merge with existing or replace

5. Add frameworks to target:
   - `NearbyInteraction.framework`
   - `MultipeerConnectivity.framework`
   - `WebKit.framework`

6. **Important**: In Build Settings, set:
   - iOS Deployment Target: `16.0`

7. Sign with your Apple Developer account (required for device testing)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Swift Native Layer                    │
├─────────────────────────────────────────────────────────┤
│  ProximityManager                                        │
│  ├── NISession (UWB ranging)                            │
│  ├── MCSession (peer discovery)                         │
│  └── Discovery token exchange                           │
├─────────────────────────────────────────────────────────┤
│  WKWebView                                               │
│  └── JavaScript Bridge                                   │
│      updateNativeProximity(distance, peerCount)         │
├─────────────────────────────────────────────────────────┤
│                    Web Layer (HTML/JS)                   │
├─────────────────────────────────────────────────────────┤
│  Web Audio API                                           │
│  ├── Base oscillator (user's tone)                      │
│  └── Harmonic oscillators (proximity-unlocked)          │
└─────────────────────────────────────────────────────────┘
```

## How It Works

1. **Peer Discovery**: Uses Multipeer Connectivity to find other devices running the app
2. **Token Exchange**: Devices exchange NIDiscoveryTokens via Multipeer
3. **UWB Ranging**: NearbyInteraction uses UWB to measure precise distance (±cm accuracy)
4. **JS Bridge**: Distance data is pushed to the WebView via `evaluateJavaScript()`
5. **Audio Response**: Web Audio API adjusts harmonic content based on distance

## Proximity → Sound Mapping

| Distance | Effect |
|----------|--------|
| > 2m | No harmonics |
| 1-2m | First harmonic (octave) fades in |
| 0.6-1m | Second harmonic (fifth) |
| 0.3-0.6m | Third harmonic (major third) |
| < 0.3m | Full harmonic richness |

## Limitations

- Only works with iPhones that have U1 chip (iPhone 11+)
- Both devices must have the app installed
- UWB has ~9m range, but accurate within ~30cm
- Background mode limited to ~30 seconds of active ranging

## Testing

1. Install on two iPhones (both 11 or newer)
2. Launch app on both
3. Tap "Play" on both
4. Move devices closer together
5. Watch the distance display update in real-time
6. Listen for harmonics emerging as devices get closer
