# Narrator - EPUB Reader with TTS Architecture

A Next.js PWA that reads EPUB files aloud using Supertonic WebGPU TTS with Parakeet.js word-level highlighting.

## Overview

```
                    ┌─────────────────────────────────────────────┐
                    │           User Interface (Next.js)          │
                    ├──────────────────────┬──────────────────────┤
                    │    Library View      │     Reader View      │
                    │  - Book upload       │  - Text display      │
                    │  - Book grid         │  - Word highlighting │
                    │  - Progress tracking │  - Playback controls │
                    │                      │  - Voice selector    │
                    └──────────────────────┴──────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
          ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
          │   EPUB Parser   │   │   Supertonic    │   │   Parakeet.js   │
          │   (epub.js)     │   │   TTS Engine    │   │   ASR Engine    │
          │                 │   │   WebGPU/WASM   │   │   WebGPU/WASM   │
          └─────────────────┘   └─────────────────┘   └─────────────────┘
                    │                      │                      │
                    └──────────────────────┼──────────────────────┘
                                           │
                              ┌────────────┴────────────┐
                              │    Audio Sync Service   │
                              │  - TTS generation       │
                              │  - Word timestamps      │
                              │  - Web Audio playback   │
                              └────────────┬────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
          ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
          │ Session Storage │   │   Service       │   │   IndexedDB     │
          │ (book data)     │   │   Worker (PWA)  │   │   (settings)    │
          └─────────────────┘   └─────────────────┘   └─────────────────┘
```

## Model Sources & Provenance

### TTS Models (Supertone Supertonic)

**Source Repository:** [huggingface.co/Supertone/supertonic](https://huggingface.co/Supertone/supertonic)

Models are downloaded via `scripts/download-models.sh` which runs automatically on `npm install` (postinstall hook).

| Model | Size | Purpose |
|-------|------|---------|
| `duration_predictor.onnx` | 1.5 MB | Predicts phoneme durations from text |
| `text_encoder.onnx` | 27 MB | Encodes text to latent embeddings |
| `vector_estimator.onnx` | 126 MB | Denoises latent vectors (diffusion model) |
| `vocoder.onnx` | 97 MB | Generates 44.1kHz waveform from latents |
| `tts.json` | Config | Model architecture config (v1.5.0) |
| `unicode_indexer.json` | 256 KB | Character-to-index vocabulary |

**Voice Styles** (from same repository):
- `M1.json` - Male voice 1
- `M2.json` - Male voice 2
- `F1.json` - Female voice 1
- `F2.json` - Female voice 2

**Total download size:** ~252 MB

### ASR Models (NVIDIA Parakeet-TDT)

**Source Repository:** [huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx)

The parakeet.js library downloads these models **at runtime** (not during install):

| Model | Purpose |
|-------|---------|
| `encoder-model.onnx` | Audio encoder (WebGPU/WASM) |
| `decoder_joint-model.onnx` | Decoder/Joiner for transcription |
| `vocab.txt` | Tokenizer vocabulary |
| `nemo128.onnx` | Audio preprocessor (mel spectrogram) |

**Caching:** Models are cached in IndexedDB (`parakeet-cache-db`) after first download (~100-200 MB).

## Project Structure

```
epub-reader/
├── src/
│   ├── app/
│   │   ├── layout.tsx                 # Root layout + providers
│   │   ├── page.tsx                   # Library view
│   │   ├── globals.css                # Theme + highlighting styles
│   │   └── reader/
│   │       └── [bookId]/page.tsx      # Reader view
│   │
│   ├── components/
│   │   ├── audio/                     # Audio-related components
│   │   │   ├── PlaybackControls.tsx   # Play/pause, skip, speed controls
│   │   │   └── Timeline.tsx           # Audio progress timeline
│   │   ├── reader/                    # Reader-specific components
│   │   │   ├── SentenceSpan.tsx       # Highlighted sentence display
│   │   │   └── VirtualizedSentenceList.tsx
│   │   ├── library/                   # Library-specific components
│   │   ├── SettingsSheet.tsx          # Settings panel
│   │   └── ServiceWorkerProvider.tsx  # PWA registration
│   │
│   ├── hooks/
│   │   ├── selectors/                 # Zustand selector hooks
│   │   └── useAudioPlayback.ts        # Audio state + playback control
│   │
│   ├── lib/
│   │   ├── epub/
│   │   │   ├── types.ts               # ParsedBook, Chapter, Sentence
│   │   │   ├── parser.ts              # epub.js wrapper
│   │   │   ├── textExtractor.ts       # HTML → text cleaning
│   │   │   ├── sentenceTokenizer.ts   # sbd sentence tokenization
│   │   │   └── index.ts
│   │   │
│   │   ├── tts/
│   │   │   ├── types.ts               # TTSConfig, Style, TTSResult
│   │   │   ├── UnicodeProcessor.ts    # Text normalization
│   │   │   ├── TextToSpeech.ts        # 4-stage ONNX pipeline
│   │   │   ├── TTSWorkerManager.ts    # Web Worker management
│   │   │   ├── tts.worker.ts          # TTS Web Worker
│   │   │   ├── loader.ts              # Model loading + WebGPU fallback
│   │   │   ├── audioUtils.ts          # WAV writing, resampling
│   │   │   └── index.ts
│   │   │
│   │   ├── asr/
│   │   │   ├── types.ts               # WordTimestamp, TranscriptionResult
│   │   │   ├── parakeet.ts            # Parakeet.js wrapper (singleton)
│   │   │   └── index.ts
│   │   │
│   │   ├── audio/
│   │   │   ├── types.ts               # SentenceAudio, PlaybackEvent
│   │   │   ├── AudioPlayer.ts         # HTMLAudioElement + word tracking
│   │   │   ├── AudioSyncService.ts    # Orchestrates TTS + ASR + playback
│   │   │   ├── PreloadQueueManager.ts # Sentence preloading
│   │   │   └── index.ts
│   │   │
│   │   ├── storage/                   # Storage utilities
│   │   ├── sync/                      # Sync utilities
│   │   │
│   │   └── pwa/
│   │       ├── serviceWorker.ts       # SW registration utilities
│   │       └── index.ts
│   │
│   ├── store/                         # Zustand state stores (modular)
│   │   ├── libraryStore.ts            # Book library management
│   │   ├── navigationStore.ts         # Chapter/sentence navigation
│   │   ├── playbackStore.ts           # Audio playback state
│   │   ├── uiStore.ts                 # Theme, font size
│   │   ├── ttsStore.ts                # TTS model loading state
│   │   ├── sentenceStateStore.ts      # Current sentence state
│   │   ├── readerStore.ts             # General reader state
│   │   └── index.ts                   # Re-exports
│   │
│   └── types/
│       ├── parakeet.d.ts              # Type declarations for parakeet.js
│       └── sbd.d.ts                   # Type declarations for sbd
│
├── public/
│   ├── models/tts/                    # Downloaded via postinstall
│   │   ├── duration_predictor.onnx
│   │   ├── text_encoder.onnx
│   │   ├── vector_estimator.onnx
│   │   ├── vocoder.onnx
│   │   ├── tts.json
│   │   └── unicode_indexer.json
│   │
│   ├── voice_styles/
│   │   ├── M1.json, M2.json           # Male voices
│   │   └── F1.json, F2.json           # Female voices
│   │
│   ├── onnx/                          # ONNX Runtime WASM files
│   │   └── ort-wasm-*.wasm/mjs
│   │
│   ├── icons/
│   │   └── icon.svg                   # PWA icon
│   │
│   ├── manifest.json                  # PWA manifest
│   └── sw.js                          # Service worker
│
├── scripts/
│   └── download-models.sh             # Model download script
│
└── package.json
```

## Core Components

### 1. EPUB Parser (`lib/epub/`)

Extracts and tokenizes text from EPUB files.

**Text Extraction Pipeline:**
```
EPUB → epub.js → HTML → Clean tags → Normalize text → Sentences
```

**Key Processing:**
- Remove: noscript, header, script, style, footer
- Clean: footnotes, special chars, quotes
- Tokenize: Intl.Segmenter (browser-native sentence splitting)

### 2. TTS Engine (`lib/tts/`)

Ported from Supertonic WebGPU TTS. 4-stage ONNX pipeline.

**Models:**
1. `duration_predictor.onnx` - Predicts phoneme durations
2. `text_encoder.onnx` - Encodes text to latent
3. `vector_estimator.onnx` - Estimates acoustic vectors
4. `vocoder.onnx` - Generates waveform

**Voice Styles:**
| Voice | File | Description |
|-------|------|-------------|
| M1 | M1.json | Male voice 1 |
| M2 | M2.json | Male voice 2 |
| F1 | F1.json | Female voice 1 |
| F2 | F2.json | Female voice 2 |

**Synthesis Flow:**
```typescript
// UnicodeProcessor normalizes text
const processed = processor.process("Hello, world!");

// TextToSpeech generates audio
const { wav, duration } = await tts.synthesize(
  processed,
  voiceStyle,  // M1, M2, F1, or F2
  5,           // quality steps
  1.0          // speed
);
// wav: Float32Array at 44.1kHz
```

### 3. Parakeet ASR (`lib/asr/`)

NVIDIA Parakeet-TDT 0.6B model for word-level timestamps.

**Features:**
- Downloads models automatically from Hugging Face
- WebGPU (preferred) or WASM fallback
- Returns word-level timestamps for audio sync

**Usage:**
```typescript
const asr = new ParakeetASR({ backend: 'webgpu' });
await asr.initialize();

// Transcribe generates word timestamps
const result = await asr.transcribe(audio16k, 16000);
// result.words: [{ text, start, end, confidence }]
```

### 4. Audio Sync Service (`lib/audio/`)

Orchestrates TTS + ASR + playback.

**Flow:**
1. User clicks sentence
2. Generate TTS audio (44.1kHz)
3. Resample to 16kHz
4. Run Parakeet ASR for word timestamps
5. Create AudioBuffer
6. Play via Web Audio API
7. Track current word via requestAnimationFrame
8. Emit `wordChange` events for highlighting

**State:**
```typescript
interface SentenceAudio {
  sentenceId: string;
  text: string;
  audioBuffer: AudioBuffer;
  wordTimestamps: WordTimestamp[];
  duration: number;
}
```

### 5. State Management (`store/`)

Uses a **modular Zustand architecture** with 7 focused stores instead of a monolithic store. Each store handles a specific domain and uses localStorage persistence via Zustand's `persist` middleware.

| Store | Purpose |
|-------|---------|
| `libraryStore` | Book library (uploaded books, metadata) |
| `navigationStore` | Current chapter/sentence indices |
| `playbackStore` | isPlaying, speed, volume, voice selection |
| `uiStore` | Theme, font size preferences |
| `ttsStore` | TTS model loading state (ready, loading, error) |
| `sentenceStateStore` | Current sentence highlighting state |
| `readerStore` | General reader state |

**Example store structure** (playbackStore):
```typescript
{
  isPlaying: boolean;
  playbackSpeed: number;      // 0.5 - 2.0
  volume: number;             // 0 - 1
  currentVoice: 'M1' | 'M2' | 'F1' | 'F2';

  // Actions
  setIsPlaying: (playing: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setCurrentVoice: (voice: string) => void;
}
```

Selector hooks in `hooks/selectors/` provide optimized access patterns.

### 6. PWA (`public/sw.js`)

**Caching Strategy:**
- Models: Cache-first (large, immutable)
- App shell: Stale-while-revalidate
- Books: Session/IndexedDB storage

**Headers (required for SharedArrayBuffer):**
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Data Flow

### Playback Flow

```
User clicks sentence
        │
        ▼
┌───────────────────┐
│ setSentence(idx)  │
│ setIsPlaying(true)│
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ useAudioPlayback  │◄──── Effect triggers on isPlaying change
│ effect            │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ service.          │
│ playSentence()    │
└───────────────────┘
        │
        ├── Check cache → Hit? Return cached
        │
        └── Miss? Generate:
            │
            ├─► TTS.synthesize() → Float32Array (44.1kHz)
            │
            ├─► Resample to 16kHz
            │
            ├─► Parakeet.transcribe() → word timestamps
            │
            └─► Cache result
        │
        ▼
┌───────────────────┐
│ AudioPlayer.      │
│ playSentence()    │
└───────────────────┘
        │
        ├─► Create AudioBufferSourceNode
        ├─► Connect to GainNode → destination
        ├─► Start playback
        └─► Start word tracking (rAF loop)
                │
                ▼
         On each frame:
         ├─► Get currentTime
         ├─► Find word at time
         └─► Emit wordChange event
                │
                ▼
┌───────────────────┐
│ handlePlayback    │
│ Event             │
└───────────────────┘
        │
        ├─► wordChange: setHighlight(sentenceId, wordIndex)
        │
        └─► sentenceEnd: nextSentence() → loop
```

### Word Highlighting

```css
/* Sentence highlighted when active */
.sentence.active {
  background-color: var(--highlight-sentence);
  box-shadow: 0 0 0 4px var(--highlight-sentence);
}

/* Current word highlighted within sentence */
.sentence.active .word.speaking {
  background-color: var(--highlight-word);
  box-shadow: 0 2px 8px var(--color-gold-glow);
  animation: wordPulse 0.3s ease-in-out;
}
```

## Themes

Three built-in themes:

| Theme | Background | Text | Highlight |
|-------|------------|------|-----------|
| Sepia | #f5ede3 | #1a1612 | #fff3c4 |
| Light | #ffffff | #1a1a1a | #e8f4fd |
| Dark | #1a1612 | #e8e0d4 | gold/15% |

## Dependencies

```json
{
  "next": "16.0.4",
  "react": "19.2.0",
  "react-dom": "19.2.0",
  "epubjs": "^0.3.93",
  "onnxruntime-web": "^1.23.2",
  "parakeet.js": "^0.0.3",
  "zustand": "^5.0.8",
  "sbd": "^1.0.19",
  "tailwindcss": "^4"
}
```

| Package | Purpose |
|---------|---------|
| `epubjs` | EPUB file parsing and chapter extraction |
| `onnxruntime-web` | ONNX model inference (WebGPU/WASM) |
| `parakeet.js` | Word-level ASR timestamps |
| `sbd` | Sentence boundary detection for text tokenization |
| `zustand` | Lightweight state management |

## Browser Requirements

- **WebGPU**: Chrome 113+, Edge 113+ (for GPU acceleration)
- **WASM fallback**: All modern browsers
- **SharedArrayBuffer**: Requires COOP/COEP headers

## Performance Notes

- TTS generation: ~1-3s per sentence (first time, cached thereafter)
- Parakeet ASR: ~0.5-1s per sentence
- Preload: Next 3 sentences cached while playing
- Memory: ~500MB for models in VRAM/RAM
- Storage:
  - TTS models: ~252 MB (downloaded on npm install)
  - ONNX WASM files: ~34 MB
  - Parakeet ASR: ~100-200 MB (cached in IndexedDB on first use)
