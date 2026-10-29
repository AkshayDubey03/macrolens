import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, imageInput } from '../lib/vision.mjs';

// Tiny PNG fixture. Tests never contact OpenAI or spend API credits.
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=';
const food = { name: 'Rice', portion: '150 g estimated', calories: 195, protein: 4, carbs: 42, fat: 0.5 };
const estimate = { title: 'Rice bowl', assumptions: ['Portion estimated from photo.'], foods: [food] };
test('image data validates media type and magic bytes', () => {
  assert.equal(imageInput(image), image);
  for (const value of ['https://external.example/image.jpg', 'data:image/jpeg;base64,bm90YW5pbWFnZQ==', image.replace('image/png', 'image/gif')]) assert.throws(() => imageInput(value));
});
test('analysis uses structured output and does not request API storage', async () => {
  let request;
  const result = await analyse({ image, notes: 'ate half' }, { apiKey: 'test', model: 'configured-model', fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); request = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(estimate) }] }] });
  } });
  assert.deepEqual(result, estimate); assert.equal(request.store, false); assert.equal(request.model, 'configured-model'); assert.equal(request.text.format.strict, true);
  assert.equal(request.input[0].content[1].image_url, image);
});
test('upstream errors and refusals never become fake nutrition entries', async () => {
  for (const response of [new Response('{}', { status: 429 }), Response.json({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot analyse' }] }] }), Response.json({ status: 'incomplete', output: [] })])
    await assert.rejects(analyse({ image, notes: '' }, { apiKey: 'test', model: 'test', fetcher: async () => response }));
});
