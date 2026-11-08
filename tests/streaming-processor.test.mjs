import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/worklets/streaming-processor.js', import.meta.url), 'utf8');

function createProcessor() {
  let Processor;
  class BaseProcessor {
    port = { messages: [], postMessage(message) { this.messages.push(message); } };
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: BaseProcessor,
    registerProcessor: (_name, constructor) => { Processor = constructor; },
    Float32Array,
    sampleRate: 24000,
    currentTime: 1,
  });
  return new Processor({ processorOptions: { sourceSampleRate: 24000 } });
}

test('empty completed streams end exactly once and respect pause', () => {
  const processor = createProcessor();
  const send = (data) => processor.port.onmessage({ data });
  const render = () => processor.process([], [[new Float32Array(128)]]);
  send({ type: 'pause', generation: 0 });
  send({ type: 'complete', generation: 0 });
  render();
  assert.equal(processor.port.messages.length, 0);
  send({ type: 'resume', generation: 0 });
  render();
  render();
  assert.equal(processor.port.messages.length, 1);
  assert.equal(processor.port.messages[0].type, 'ended');
  assert.equal(processor.port.messages[0].samplesConsumed, 0);
});

test('a reset rejects old chunks and allows a short stream to finish', () => {
  const processor = createProcessor();
  const send = (data) => processor.port.onmessage({ data });
  send({ type: 'reset', generation: 1 });
  send({ type: 'chunk', generation: 0, audio: new Float32Array([1, 1]) });
  send({ type: 'chunk', generation: 1, audio: new Float32Array([0.5, 0.5]) });
  send({ type: 'complete', generation: 1 });
  const output = new Float32Array(128);
  processor.process([], [[output]]);
  assert.equal(output[0], 0.5);
  assert.deepEqual(processor.port.messages.map((message) => message.type), ['started', 'ended']);
  assert.ok(processor.port.messages.every((message) => message.generation === 1));
});
