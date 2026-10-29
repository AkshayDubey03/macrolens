import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { emptyState } from '../lib/domain.mjs';

const password = 'test-only-password-123';
async function start(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'macrolens-test-'));
  const server = createApp({ password, apiKey: '', dataDir: dir, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const login = await call('/api/session', { method: 'POST', body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  return { call, cookie, dir };
}
test('private journal requires login, sets HttpOnly cookies, rejects cross-origin writes', async t => {
  const { call, cookie } = await start(t);
  assert.match(cookie, /^ml_session=/);
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call('/api/state', { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://other.example' }, body: JSON.stringify({ revision: 0, state: emptyState() }) })).status, 400);
  const login = await call('/api/session', { method: 'POST', body: JSON.stringify({ password }) });
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});
test('save is persistent, rejects stale revisions, and ignores photo fields', async t => {
  const { call, cookie, dir } = await start(t);
  const state = { ...emptyState(), meals: [{ id: 'one', date: '2026-10-29', type: 'Lunch', title: 'Rice', notes: '', source: 'manual', image: 'must-not-persist', foods: [{ name: 'Rice', portion: '100 g', calories: 130, protein: 2.7, carbs: 28, fat: 0.3 }] }] };
  const write = () => call('/api/state', { method: 'PUT', headers: { Cookie: cookie }, body: JSON.stringify({ revision: 0, state }) });
  assert.equal((await write()).status, 200);
  assert.equal((await write()).status, 409);
  const read = await (await call('/api/state', { headers: { Cookie: cookie } })).json();
  assert.equal(read.revision, 1); assert.equal(read.state.meals.length, 1); assert.equal('image' in read.state.meals[0], false);
  const second = createApp({ password, dataDir: dir });
  second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try {
    const url = `http://127.0.0.1:${second.address().port}`;
    const auth = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const result = await fetch(`${url}/api/state`, { headers: { Cookie: auth.headers.get('set-cookie').split(';')[0] } });
    assert.equal((await result.json()).state.meals[0].title, 'Rice');
  } finally { second.close(); await once(second, 'close'); }
});
test('demo cannot access private storage or AI, secrets and data are never static assets', async t => {
  const { call } = await start(t, { password: '', apiKey: 'not-a-real-key' });
  assert.deepEqual(await (await call('/api/config')).json(), { authRequired: false, authenticated: false, aiConfigured: false, model: null });
  for (const path of ['/api/state', '/api/analyse']) assert.equal((await call(path)).status, 401);
  for (const path of ['/.env', '/server.mjs', '/.data/journal.sqlite', '/%2e%2e/server.mjs']) assert.equal((await call(path)).status, 404);
  assert.equal((await call('/')).status, 200);
});
test('missing AI config, malformed payloads, session tampering, and sign out are handled', async t => {
  const { call, cookie } = await start(t);
  assert.equal((await call('/api/analyse', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status, 503);
  assert.equal((await call('/api/state', { headers: { Cookie: cookie + 'changed' } })).status, 401);
  for (const payload of ['null', '[]', '{broken']) assert.equal((await call('/api/state', { method: 'PUT', headers: { Cookie: cookie }, body: payload })).status, 400);
  const logout = await call('/api/session', { method: 'DELETE', headers: { Cookie: cookie }, body: '{}' });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
test('repeated failed sign-ins are throttled', async t => {
  const { call } = await start(t);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/session', { method: 'POST', body: '{"password":"wrong"}' })).status, 401);
  assert.equal((await call('/api/session', { method: 'POST', body: JSON.stringify({ password }) })).status, 429);
});
test('install manifest icons and frontend modules resolve with correct content types', async t => {
  const { call } = await start(t, { password: '' });
  const manifest = await (await call('/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const result = await call(icon.src);
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), icon.type);
    assert.ok((await result.arrayBuffer()).byteLength > 100);
  }
  for (const path of ['/app.js', '/domain.mjs', '/sw.js']) {
    const result = await call(path); assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'text/javascript');
  }
  const page = await call('/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
});
test('analysis endpoint enforces its daily cap without saving an unreviewed meal', async t => {
  const { call, cookie } = await start(t, {
    apiKey: 'test-only',
    fetcher: async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ title: 'Test', assumptions: ['Test fixture'], foods: [{ name: 'Rice', portion: '100 g', calories: 130, protein: 3, carbs: 28, fat: 0.3 }] }) }] }] })
  });
  const input = { notes: 'test', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=' };
  for (let i = 0; i < 20; i++) {
    const result = await call('/api/analyse', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(input) });
    assert.equal(result.status, 200);
  }
  assert.equal((await call('/api/analyse', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(input) })).status, 429);
  const read = await (await call('/api/state', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(read.state, emptyState());
});
