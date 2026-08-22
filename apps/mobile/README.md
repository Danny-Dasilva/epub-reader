# Narrator Mobile

The Expo SDK 57 port of Narrator. It imports EPUB files on-device, persists the
parsed library locally, synthesizes with the Inflect Sky v3 ONNX export, plays
24 kHz audio through `expo-audio`, and keeps sentence and word highlighting in
sync with playback.

## Development

```bash
npm install
npm test
npm run typecheck
npm run android
```

Sky v3 uses `onnxruntime-react-native`, so this app must run in an Expo
development build or a release build. It cannot run inside Expo Go. The first
play downloads the roughly 36 MB Sky v3 model from
`Danny-Dasilva/inflect-kokoro-voices/sky-v3` and caches it in the app's document
directory.

## Android end-to-end test

The Maestro flow imports a real EPUB through the same parser and repository as
a user import, then verifies sentence selection, Sky v3 playback, pause/resume,
next/previous sentence navigation, word highlighting, narration speed, and
chapter navigation.

Build the E2E variant and run the flow on an Android emulator:

```bash
EXPO_PUBLIC_E2E=1 npx expo run:android
npm run test:e2e:android
```

`EXPO_PUBLIC_E2E` only exposes the deterministic fixture-import button in E2E
builds. Regular development and production builds do not include that control.

The web application remains at the repository root. Mobile code is intentionally
isolated here so both clients can evolve without platform-specific dependencies
leaking across their bundles.
