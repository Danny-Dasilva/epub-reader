import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup() {
  class MinHeap {
    constructor(compare) { this.compare = compare; this.items = []; }
    get size() { return this.items.length; }
    push(item) { this.items.push(item); this.items.sort(this.compare); }
    pop() { return this.items.shift(); }
    peek() { return this.items[0]; }
    clear() { this.items = []; }
    toArray() { return [...this.items]; }
  }
  const source = ts.transpileModule(readFileSync(new URL('../src/lib/audio/PreloadQueueManager.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, console, DOMException, AbortController, setTimeout,
    require(id) {
      if (id === '../utils/MinHeap') return { MinHeap };
      if (id === './AudioCacheService') return { getAudioCacheService: () => ({}) };
      if (id === '../tts/audioUtils' || id === '../asr/parakeet') return {};
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const calls = [];
  const tts = {
    getWorkerCount: () => 1,
    synthesize(text, _options, signal) {
      calls.push(text);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
  const manager = new exports.PreloadQueueManager(tts, { batchCharLimit: 1000 });
  return { manager, calls };
}

const sentences = [
  { id: 's0', text: 'First sentence.' },
  { id: 's1', text: 'Second sentence.' },
  { id: 's2', text: 'Third sentence.' },
];

test('urgent playback requeues the other sentences in its aborted batch', async () => {
  const { manager, calls } = setup();
  manager.preloadFullChapter(sentences, 0);
  assert.deepEqual(calls, ['First sentence. Second sentence. Third sentence.']);
  const urgent = new AbortController();
  const request = manager.prepareSentence(sentences[0], urgent.signal);
  await new Promise(setImmediate);
  assert.ok(calls.includes('First sentence.'));
  assert.ok(calls.includes('Second sentence. Third sentence.'), 'batch siblings should be retried');
  urgent.abort();
  await assert.rejects(request, { name: 'AbortError' });
  manager.dispose();
});

test('cancelling the preload session does not requeue an aborted batch', async () => {
  const { manager, calls } = setup();
  manager.preloadFullChapter(sentences, 0);
  manager.cancelSession();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  manager.dispose();
});
