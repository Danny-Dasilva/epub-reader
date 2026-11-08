import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup() {
  const pending = [];
  const store = { session: { isPaused: false }, isPlaying: true };
  class FakeWorklet {
    async initialize() { await new Promise((resolve) => pending.push(resolve)); }
    connect() {}
    disconnect() {}
    setVolume() {}
    setCallbacks() {}
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    reset() {}
    dispose() { this.disposed = true; }
  }
  class FakeAudio {
    pause() {}
    hasAttribute() { return false; }
  }
  class FakeContext {
    state = 'running';
    destination = {};
    createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {} }; }
    createMediaElementSource() { return { connect() {} }; }
  }
  const source = ts.transpileModule(readFileSync(new URL('../src/lib/audio/AudioPlayer.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, console, DOMException, Audio: FakeAudio, AudioContext: FakeContext,
    require(id) {
      if (id === './StreamingAudioWorklet') return { StreamingAudioWorklet: FakeWorklet };
      if (id === '@/store/playbackStore') return { usePlaybackStore: { getState: () => store } };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return { player: new exports.AudioPlayer(), pending, store };
}

test('pause and resume during worklet initialization starts a fresh session', async () => {
  const { player, pending, store } = setup();
  const sentence = { sentenceId: 'one', sampleRate: 24000 };
  const first = player.startStreamingPlayback(sentence);
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  player.pauseStreaming();
  store.session.isPaused = true;
  // The hook uses this result to decide whether it must start again.
  assert.equal(player.resumeStreaming(), false);
  store.session.isPaused = false;
  const second = player.startStreamingPlayback(sentence);
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  pending[0]();
  await assert.rejects(first, { name: 'AbortError' });
  pending[1]();
  assert.ok(await second);
  assert.equal(player.isStreaming(), true);
});

test('pause during initialization is retained when the worklet becomes ready', async () => {
  const { player, pending, store } = setup();
  const start = player.startStreamingPlayback({ sentenceId: 'one', sampleRate: 24000 });
  await new Promise(setImmediate);
  player.pauseStreaming();
  store.session.isPaused = true;
  pending[0]();
  const worklet = await start;
  assert.equal(worklet.paused, true);
  assert.equal(player.resumeStreaming(), true);
  assert.equal(worklet.paused, false);
});
