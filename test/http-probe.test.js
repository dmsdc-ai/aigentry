'use strict';
// Probe layer: the real httpGetJson against an in-process loopback server owned by this test
// (no host probing, no real daemon), and the Probe → state mapping of probeHealth/probeMeta/listSessions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const H = require('./helpers/fixture');

const { telepty } = H.loadLib();

async function serve(t, handler) {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push({ url: req.url, method: req.method, headers: req.headers }); handler(req, res); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { if (s.closeAllConnections) s.closeAllConnections(); s.close(() => r()); }));
  return { port: s.address().port, seen };
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

describe('httpGetJson (loopback, bounded)', () => {
  it('200 JSON → ok with body; token only in x-telepty-token', async (t) => {
    const srv = await serve(t, (req, res) => json(res, 200, { status: 'ok', version: '0.8.5' }));
    const p = await telepty.httpGetJson({ port: srv.port, path: '/api/meta', token: H.TOKEN, timeoutMs: 2000, maxBytes: 65536 });
    assert.equal(p.kind, 'ok');
    assert.equal(p.status, 200);
    assert.deepEqual(p.body, { status: 'ok', version: '0.8.5' });
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].method, 'GET');
    assert.equal(srv.seen[0].url, '/api/meta');
    assert.equal(srv.seen[0].headers['x-telepty-token'], H.TOKEN);
    for (const [k, v] of Object.entries(srv.seen[0].headers)) {
      if (k !== 'x-telepty-token') assert.ok(!String(v).includes(H.TOKEN), `token leaked into header ${k}`);
    }
  });

  it('no token → no auth header', async (t) => {
    const srv = await serve(t, (req, res) => json(res, 200, { status: 'ok', version: '1' }));
    await telepty.httpGetJson({ port: srv.port, path: '/api/health', timeoutMs: 2000, maxBytes: 65536 });
    assert.equal(srv.seen[0].headers['x-telepty-token'], undefined);
  });

  for (const status of [401, 403, 404, 500, 302]) {
    it(`${status} → answered (redirects are not followed)`, async (t) => {
      const srv = await serve(t, (req, res) => {
        if (status === 302) { res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return; }
        json(res, status, { error: 'x' });
      });
      const p = await telepty.httpGetJson({ port: srv.port, path: '/api/meta', token: H.TOKEN, timeoutMs: 2000, maxBytes: 65536 });
      assert.equal(p.kind, 'answered');
      assert.equal(p.status, status);
      assert.equal(srv.seen.length, 1);
    });
  }

  it('200 non-JSON → malformed', async (t) => {
    const srv = await serve(t, (req, res) => { res.writeHead(200); res.end('<html>hi</html>'); });
    const p = await telepty.httpGetJson({ port: srv.port, path: '/api/health', timeoutMs: 2000, maxBytes: 65536 });
    assert.equal(p.kind, 'malformed');
  });

  it('a body over maxBytes is never accepted', async (t) => {
    const big = JSON.stringify({ status: 'ok', pad: 'x'.repeat(256 * 1024) });
    const srv = await serve(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(big); });
    const p = await telepty.httpGetJson({ port: srv.port, path: '/api/health', timeoutMs: 3000, maxBytes: 4096 });
    assert.notEqual(p.kind, 'ok');
  });

  it('no response → timeout within the budget', async (t) => {
    const srv = await serve(t, () => { /* never answer */ });
    const t0 = Date.now();
    const p = await telepty.httpGetJson({ port: srv.port, path: '/api/health', timeoutMs: 200, maxBytes: 65536 });
    assert.equal(p.kind, 'timeout');
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });

  it('a body that never finishes → timeout (the budget covers the body)', async (t) => {
    const srv = await serve(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":"ok",'); });
    const t0 = Date.now();
    const p = await telepty.httpGetJson({ port: srv.port, path: '/api/health', timeoutMs: 250, maxBytes: 65536 });
    assert.equal(p.kind, 'timeout');
    assert.ok(Date.now() - t0 < 3000);
  });

  it('ECONNREFUSED on a port this test just released → refused', async () => {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    const p = await telepty.httpGetJson({ port, path: '/api/health', timeoutMs: 2000, maxBytes: 65536 });
    assert.equal(p.kind, 'refused');
  });
});

describe('probe mapping (injected rt.http)', () => {
  const rtWith = (t, routes) => H.makeRt(H.makeFixture(t), { http: H.fakeDaemon(routes), env: { TELEPTY_AUTH_TOKEN: H.TOKEN } });

  it('probeHealth: ok → running+version; refused → stopped; anything else → unknown', async (t) => {
    const cases = [
      [H.healthy('0.8.9'), 'running'],
      [H.P.refused(), 'stopped'],
      [H.P.timeout(), 'unknown'],
      [H.P.malformed(), 'unknown'],
      [H.P.answered(401), 'unknown'],
      [H.P.answered(503), 'unknown'],
      [H.P.error('ECONNRESET'), 'unknown'],
      [H.P.error('EHOSTUNREACH'), 'unknown'],
      [H.P.ok({ hello: 'world' }), 'unknown'],
      [H.P.ok('ok'), 'unknown'],
    ];
    for (const [probe, state] of cases) {
      const h = rtWith(t, { health: probe });
      const r = await telepty.probeHealth(h.rt, 3848, 500);
      assert.equal(r.state, state, JSON.stringify(probe));
      if (state === 'running') assert.equal(r.version, '0.8.9');
      assert.ok(h.rec.http.every((c) => c.port === 3848 && c.path === '/api/health'));
    }
  });

  it('probeMeta: no token never calls /api/meta', async (t) => {
    const fx = H.makeFixture(t);
    const h = H.makeRt(fx, { http: H.fakeDaemon({}) });
    const r = await telepty.probeMeta(h.rt, 3848, 500);
    assert.equal(r.state, 'no-token');
    assert.equal(h.rec.http.length, 0);
    assert.equal(fs.existsSync(path.join(fx.home, '.telepty')), false, 'no config minted');
  });

  it('probeMeta: 401/403 → refused; timeout/malformed → unknown; ok → meta', async (t) => {
    for (const [probe, state] of [[H.P.answered(401), 'refused'], [H.P.answered(403), 'refused'], [H.P.timeout(), 'unknown'], [H.P.malformed(), 'unknown']]) {
      const h = rtWith(t, { meta: probe });
      assert.equal((await telepty.probeMeta(h.rt, 3848, 500)).state, state, JSON.stringify(probe));
      assert.equal(h.rec.http[0].token, H.TOKEN);
    }
    const h = rtWith(t, { meta: H.P.ok({ name: 'telepty', version: '0.8.5', pid: 4321, port: 3848, capabilities: [] }) });
    const r = await telepty.probeMeta(h.rt, 3848, 500);
    assert.equal(r.state, 'ok');
    assert.equal(r.meta.pid, 4321);
    assert.equal(r.meta.version, '0.8.5');
  });

  it('listSessions: rows on ok; unknown for timeout/malformed/non-list; refused for 401', async (t) => {
    const rows = [{ id: 'orchestrator', type: 'wrapped', healthStatus: 'CONNECTED', ownerPid: 1 }, { id: 's1', type: 'spawned', healthStatus: 'CONNECTED', ownerPid: 2 }];
    const h = rtWith(t, { sessions: H.P.ok(rows) });
    const r = await telepty.listSessions(h.rt, 3848, 500);
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.rows.map((x) => [x.id, x.type]), [['orchestrator', 'wrapped'], ['s1', 'spawned']]);
    for (const [probe, state] of [[H.P.timeout(), 'unknown'], [H.P.malformed(), 'unknown'], [H.P.ok({ not: 'a list' }), 'unknown'], [H.P.answered(401), 'refused']]) {
      const h2 = rtWith(t, { sessions: probe });
      assert.equal((await telepty.listSessions(h2.rt, 3848, 500)).state, state, JSON.stringify(probe));
    }
  });
});

describe('resolvePort / readToken', () => {
  it('flag > TELEPTY_PORT > 3848', () => {
    assert.deepEqual([telepty.resolvePort(undefined, {}).port, telepty.resolvePort(undefined, {}).ok], [3848, true]);
    assert.equal(telepty.resolvePort(undefined, { TELEPTY_PORT: '5000' }).port, 5000);
    assert.equal(telepty.resolvePort('4000', { TELEPTY_PORT: '5000' }).port, 4000);
    assert.equal(telepty.resolvePort('65535', {}).port, 65535);
    assert.equal(telepty.resolvePort('1', {}).port, 1);
  });

  for (const bad of ['abc', '0', '65536', '-1', '12.5', '3848abc']) {
    it(`invalid port ${JSON.stringify(bad)} is an error (flag and env), never a silent default`, () => {
      assert.equal(telepty.resolvePort(bad, {}).ok, false);
      assert.equal(telepty.resolvePort(undefined, { TELEPTY_PORT: bad }).ok, false);
    });
  }

  it('env token beats config; config is read, never written; absence mints nothing', (t) => {
    const fx = H.makeFixture(t);
    const h0 = H.makeRt(fx);
    const none = telepty.readToken(h0.rt);
    assert.equal(none.token, null);
    assert.equal(fs.existsSync(path.join(fx.home, '.telepty')), false);
    const cfg = H.writeTeleptyConfig(fx, { authToken: 'from-config-123' });
    const h1 = H.makeRt(fx);
    assert.deepEqual([telepty.readToken(h1.rt).token, telepty.readToken(h1.rt).source], ['from-config-123', 'config']);
    const h2 = H.makeRt(fx, { env: { TELEPTY_AUTH_TOKEN: H.TOKEN } });
    assert.deepEqual([telepty.readToken(h2.rt).token, telepty.readToken(h2.rt).source], [H.TOKEN, 'env']);
    fs.writeFileSync(cfg, '{broken');
    const before2 = H.snapshotTree(fx.home);
    assert.equal(telepty.readToken(H.makeRt(fx).rt).token, null);
    assert.deepEqual(H.snapshotTree(fx.home), before2);
  });
});
