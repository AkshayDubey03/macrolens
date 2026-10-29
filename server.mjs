import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assert, emptyState, validateState } from './lib/domain.mjs';
import { analyse } from './lib/vision.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/domain.mjs', ['../lib/domain.mjs', 'text/javascript']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']], ['/sw.js', ['sw.js', 'text/javascript']],
  ['/icon-192.png', ['icon-192.png', 'image/png']], ['/icon-512.png', ['icon-512.png', 'image/png']]
]);
const hash = value => createHash('sha256').update(value).digest();
const safeEqual = (a, b) => timingSafeEqual(hash(a), hash(b));

export function createApp(options = {}) {
  const password = options.password ?? process.env.APP_PASSWORD ?? '';
  if (password && password.length < 12) throw new Error('APP_PASSWORD must contain at least 12 characters');
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  const secure = options.secure ?? process.env.COOKIE_SECURE === 'true';
  const secret = randomBytes(32);
  let db;
  if (password) {
    const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? resolve(root, '.data'));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(resolve(dataDir, 'journal.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO journal VALUES (1, 0, ?)').run(JSON.stringify(emptyState()));
  }
  const attempts = new Map();
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  function authenticated(req) {
    if (!password) return false;
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ml_session='))?.slice(11);
    if (!cookie) return false;
    const [expires, signature] = cookie.split('.');
    return /^\d+$/.test(expires) && Number(expires) > Date.now() && typeof signature === 'string' && safeEqual(sign(expires), signature);
  }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; assert(size <= 8_000_000, 'Request is too large'); chunks.push(chunk); }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'JSON object required');
    return parsed;
  }
  function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [path, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(resolve(root, 'public', path)));
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      if (req.method !== 'GET') {
        assert(req.headers['content-type']?.startsWith('application/json'), 'JSON content type required');
        const origin = req.headers.origin;
        if (origin) assert(new URL(origin).host === req.headers.host, 'Cross-origin requests are not allowed');
        assert(req.headers['sec-fetch-site'] !== 'cross-site', 'Cross-site requests are not allowed');
      }
      const auth = authenticated(req);
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { authRequired: Boolean(password), authenticated: auth, aiConfigured: auth && Boolean(apiKey), model: auth ? model : null });
      if (url.pathname === '/api/session' && req.method === 'POST') {
        if (!password) return json(res, 403, { error: 'This server is a demo. Set APP_PASSWORD to enable a private journal.' });
        const input = await body(req);
        const ip = req.socket.remoteAddress;
        if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until <= Date.now()) attempts.delete(key);
        const attempt = attempts.get(ip);
        if (attempt?.until > Date.now() && attempt.count >= 5) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
        if (typeof input.password !== 'string' || !safeEqual(input.password, password)) {
          const previous = attempt?.until > Date.now() ? attempt : { count: 0, until: Date.now() + 900000 };
          attempts.set(ip, { ...previous, count: previous.count + 1 }); return json(res, 401, { error: 'Incorrect password' });
        }
        attempts.delete(ip);
        const expires = String(Date.now() + 7 * 86400000);
        res.setHeader('Set-Cookie', `ml_session=${expires}.${sign(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/session' && req.method === 'DELETE') {
        res.setHeader('Set-Cookie', `ml_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (!auth) return json(res, 401, { error: 'Sign in to use your private journal' });
      if (url.pathname === '/api/state' && req.method === 'GET') {
        const row = db.prepare('SELECT revision, data FROM journal WHERE id=1').get();
        return json(res, 200, { revision: row.revision, state: JSON.parse(row.data) });
      }
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        const input = await body(req); assert(Number.isSafeInteger(input.revision) && input.revision >= 0, 'Invalid revision');
        const state = validateState(input.state);
        const changed = db.prepare('UPDATE journal SET data=?, revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(state), input.revision);
        if (!changed.changes) return json(res, 409, { error: 'Your journal changed in another tab or device. Reload before editing; your current edit has not been saved.' });
        return json(res, 200, { revision: input.revision + 1, state });
      }
      if (url.pathname === '/api/analyse' && req.method === 'POST') {
        if (!apiKey) return json(res, 503, { error: 'Photo analysis needs a server-side OpenAI API key. You can still log meals manually.' });
        const input = await body(req);
        const day = new Date().toISOString().slice(0, 10);
        const limit = Math.max(1, Math.min(1000, Number(process.env.AI_DAILY_LIMIT) || 20));
        const count = db.prepare('SELECT count FROM ai_usage WHERE day=?').get(day)?.count ?? 0;
        if (count >= limit) return json(res, 429, { error: 'Daily photo-analysis limit reached. Manual logging is still available.' });
        db.prepare('INSERT INTO ai_usage VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);
        return json(res, 200, await analyse(input, { apiKey, model, fetcher: options.fetcher }));
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'The request could not be completed. Please try again.' });
      else res.end();
    }
  });
  server.requestTimeout = 75000;
  server.on('close', () => db?.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  createApp().listen(port, host, () => console.log(`MacroLens: http://${host}:${port} (${process.env.APP_PASSWORD ? 'private journal enabled' : 'sample-data demo'})`));
}
