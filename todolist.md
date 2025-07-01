# Philip Glass "In The Upper Room: Dance IX" Implementation Plan

## Current Issues to Fix First

### 1. Right Hand Chord Response (IN PROGRESS)
- **Problem**: Moving right hand up/down doesn't change chord progression
- **Debug**: Add logging to see if chord recreation is triggering
- **Fix**: Adjust threshold sensitivity and chord change logic
- **Expected**: Right hand Y-position should drive harmonic progression

## Core Philip Glass Features Implementation

### 2. Driving Arpeggiated Patterns in Different Voices
- **Current**: Single left-hand arpeggio only
- **Needed**: Multiple simultaneous arpeggio voices
- **Implementation**:
  - Allow multiple active arpeggios with different cycle lengths
  - Each voice should have different register (octave)
  - Left hand X-position controls number of active voices (1-4)
  - Left hand Y-position controls harmonic center
- **Glass Style**: Interlocking patterns like in measure 1-16 of Dance IX

### 3. Layered Polyrhythms with Different Cycle Lengths  
- **Current**: All patterns use same tempo division (/8)
- **Needed**: Polyrhythmic layering
- **Implementation**:
  - Voice 1: 8th notes (current)
  - Voice 2: Triplet 8th notes 
  - Voice 3: 16th notes
  - Voice 4: Dotted 8th notes
- **Glass Style**: Creating the "phase music" effect where patterns drift in/out of sync

### 4. Harmonic Shifts That Create Tension and Release
- **Current**: Static chord voicings
- **Needed**: Progressive harmonic movement
- **Implementation**:
  - Right hand Y-position: Root movement through modes (Dorian → Aeolian → Mixolydian)
  - Right hand X-position: Chord density (triad → 7th → cluster → full orchestra)
  - Dynamic voice leading between chord changes
- **Glass Style**: The harmonic sequence from mm. 17-32 in Dance IX

### 5. Dynamic Orchestral Texture That Builds and Recedes
- **Current**: Binary on/off chords
- **Needed**: Gradual textural changes
- **Implementation**:
  - Hand distance controls orchestration density
  - Close hands: Solo voices only
  - Medium distance: Chamber ensemble (4-6 voices)
  - Wide hands: Full orchestral texture (12+ voices)
  - Smooth crossfading between texture levels
- **Glass Style**: The build from solo to full orchestra in Dance IX climax

### 6. Interlocking Rhythmic Cycles That Phase In/Out
- **Current**: Simple repeating patterns
- **Needed**: Steve Reich-style phasing
- **Implementation**:
  - Each voice has slightly different tempo (±2-5%)
  - Patterns gradually shift phase relationships
  - Hand gestures control phase acceleration/deceleration
  - Visual feedback shows phase relationships
- **Glass Style**: The interlocking cycles that create the hypnotic effect

## Advanced Features

### 7. Gesture-Based Orchestration Control
- **Left Hand Gestures**:
  - Vertical: Harmonic progression (root movement)
  - Horizontal: Voice count (1-4 simultaneous arpeggios)
  - Depth (volume): Rhythmic intensity (8th → 16th → 32nd notes)
  
- **Right Hand Gestures**:
  - Vertical: Orchestral register (bass → treble)
  - Horizontal: Harmonic density (simple → complex chords)
  - Depth (volume): Dynamic level (pp → ff)

### 8. Philip Glass Scale Systems
- **Current**: Simple C Dorian
- **Needed**: Glass's characteristic modal collections
- **Implementation**:
  - Mode selector: Dorian, Aeolian, Mixolydian, Phrygian
  - Automatic modal interchange based on harmonic progression
  - Characteristic Glass interval patterns (4ths, 5ths, octaves)

### 9. Audio Synthesis Improvements
- **Current**: Simple sine waves
- **Needed**: Glass ensemble timbres
- **Implementation**:
  - Piano: Attack transients + string resonance modeling
  - Strings: Bowed articulation with vibrato
  - Winds: Breath noise + harmonic filtering
  - Ensemble: Subtle detuning and timing variations

### 10. Performance Interface
- **Visual Feedback**:
  - Real-time pattern visualization (like a conductor's score)
  - Phase relationship indicators
  - Harmonic analysis display
  - Voice count and texture meters

- **Performance Aids**:
  - Gesture stability zones (avoid jitter)
  - Smooth transitions between sections
  - Preset starting points for different Dance IX sections

## Testing Milestones

### Phase 1: Fix Right Hand Response
- Right hand Y-movement triggers chord changes
- Debug logging confirms proper threshold detection

### Phase 2: Multiple Voice Arpeggios  
- Left hand controls 1-4 simultaneous arpeggio voices
- Each voice has different cycle length
- Proper Glass-style additive patterns

### Phase 3: Harmonic Progression
- Right hand drives modal harmonic movement
- Smooth voice leading between chords
- Tension and release cycles

### Phase 4: Polyrhythmic Layering
- Multiple tempo relationships (2:3, 3:4, etc.)
- Phase relationships that evolve over time
- Visual feedback for phase alignment

### Phase 5: Full Orchestral Texture
- Hand distance controls orchestration
- Smooth transitions between solo and tutti
- Authentic Glass ensemble sound

## Reference Points

**Target Sound**: Philip Glass - "In The Upper Room: Dance IX"
- **Tempo**: ♩ = 144 BPM (driving energy)
- **Key Features**: Interlocking arpeggios, modal harmony, polyrhythmic texture
- **Form**: Building intensity with harmonic sequences
- **Orchestration**: Piano, strings, winds in characteristic Glass layering

**Similar Works for Reference**:
- "Glassworks" - Opening movement
- "Music in Similar Motion" 
- "Music in Fifths"
- Einstein on the Beach - "Building" section