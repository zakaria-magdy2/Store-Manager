import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  CARTON_SIZES,
  CARTON_TYPES,
  QUICK_COLORS,
  buildMultiCartonDistribution,
  mergeDuplicateSkuNewProducts,
} from '../public/carton-presets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rawAppSource = await readFile(join(here, '..', 'public', 'app.js'), 'utf8');
const appSource = rawAppSource.replace(
  /^\s*import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/carton-presets\.mjs['"];?\s*/u,
  '',
);

function createElement(id = '') {
  const listeners = {};
  return {
    id,
    innerHTML: '',
    value: '',
    textContent: '',
    style: {},
    dataset: {},
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild() {},
    remove() {},
    focus() {},
    select() {},
    listeners,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Loads app.js into an isolated vm realm with browser stubs. `routes` maps an API path prefix to a
 * handler returning a response object or throwing (to simulate network failure).
 */
function loadApp(routes) {
  const appRoot = createElement('app');
  const calls = [];
  const timers = [];
  const storage = new Map();
  const fetchStub = async (path) => {
    const url = String(path);
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return jsonResponse(404, { error: 'not stubbed' });
    return routes[key](url);
  };
  const documentStub = {
    querySelector: (selector) => (selector === '#app' ? appRoot : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => createElement(),
    addEventListener() {},
    removeEventListener() {},
    body: createElement('body'),
    documentElement: { dataset: {}, setAttribute() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } },
  };
  const windowStub = {
    __RETAILOS_DISABLE_AUTOSTART__: true,
    location: { href: 'http://127.0.0.1:4310/', reload() {} },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    open: () => null,
  };
  const context = {
    window: windowStub,
    document: documentStub,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchStub,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    console,
    URL,
    URLSearchParams,
    Intl,
    Date,
    FormData: class { constructor() { this.entries = []; } get() { return null; } },
    CARTON_SIZES,
    CARTON_TYPES,
    QUICK_COLORS,
    buildMultiCartonDistribution,
    mergeDuplicateSkuNewProducts,
  };
  windowStub.document = documentStub;
  vm.createContext(context);
  vm.runInContext(appSource, context, { filename: 'app.js' });
  return {
    context,
    appRoot,
    calls,
    timers,
    run: (code) => vm.runInContext(code, context),
  };
}

const throwNetwork = () => { throw new TypeError('Failed to fetch'); };
const bootstrapOk = () => jsonResponse(200, { configured: true, setupRequired: false, companyName: 'متجر', currency: 'EGP' });
const activeLicense = () => jsonResponse(200, { status: 'ACTIVE', machineId: 'M-1', reason: '', daysRemaining: 30 });
const unauthenticated = () => jsonResponse(401, { error: 'يجب تسجيل الدخول' });

test('license fetch network failure yields retryable fail-closed state, never null, and skips /api/data', async () => {
  const app = loadApp({ '/api/bootstrap': bootstrapOk, '/api/license/status': throwNetwork, '/api/data': unauthenticated });
  await app.run('start()');
  const lic = app.run('state.license');
  assert.ok(lic, 'license state must never be null');
  assert.equal(lic.status, 'LICENSE_CHECK_RETRYABLE');
  assert.equal(lic.retryable, true);
  assert.ok(!app.calls.some((c) => c.startsWith('/api/data')), '/api/data must not be called without ACTIVE license');
  assert.match(app.appRoot.innerHTML, /license-hardware-retry-box/);
  assert.doesNotMatch(app.appRoot.innerHTML, /license-token-input/);
  assert.ok(app.timers.some((t) => t.ms === 3000), 'automatic retry must be scheduled');
});

test('503 HARDWARE_IDENTITY_UNAVAILABLE yields HARDWARE_UNAVAILABLE retry screen without loading data', async () => {
  const app = loadApp({
    '/api/bootstrap': bootstrapOk,
    '/api/license/status': () => jsonResponse(503, { error: 'تعذر التحقق المؤقت', code: 'HARDWARE_IDENTITY_UNAVAILABLE', retryable: true }),
    '/api/data': unauthenticated,
  });
  await app.run('start()');
  assert.equal(app.run('state.license.status'), 'HARDWARE_UNAVAILABLE');
  assert.ok(!app.calls.some((c) => c.startsWith('/api/data')));
  assert.match(app.appRoot.innerHTML, /retry-license-status-btn/);
});

test('generic 500 from license endpoint is retryable (not UNLICENSED, not null)', async () => {
  const app = loadApp({
    '/api/bootstrap': bootstrapOk,
    '/api/license/status': () => jsonResponse(500, { error: 'internal' }),
  });
  await app.run('start()');
  assert.equal(app.run('state.license.status'), 'LICENSE_CHECK_RETRYABLE');
  assert.equal(app.run('isRetryableLicenseStatus(state.license)'), true);
});

test('bootstrap failure never renders fatal-state; it renders the retry screen and schedules a retry', async () => {
  const app = loadApp({ '/api/bootstrap': throwNetwork, '/api/license/status': activeLicense });
  await app.run('start()');
  assert.doesNotMatch(app.appRoot.innerHTML, /fatal-state/);
  assert.match(app.appRoot.innerHTML, /license-hardware-retry-box/);
  assert.equal(app.run('state.bootstrap'), null);
  assert.ok(app.timers.some((t) => t.ms === 3000));
});

test('definitive EXPIRED license blocks operations and does not call /api/data on startup', async () => {
  const app = loadApp({
    '/api/bootstrap': bootstrapOk,
    '/api/license/status': () => jsonResponse(200, { status: 'EXPIRED', machineId: 'M-1', reason: 'منتهي' }),
    '/api/data': unauthenticated,
  });
  await app.run('start()');
  assert.ok(!app.calls.some((c) => c.startsWith('/api/data')));
  assert.match(app.appRoot.innerHTML, /license-token-input/);
  assert.equal(app.timers.filter((t) => t.ms === 3000).length, 0, 'no auto-retry for definitive status');
});

test('ACTIVE license attempts session hydration and falls back to login on 401', async () => {
  const app = loadApp({ '/api/bootstrap': bootstrapOk, '/api/license/status': activeLicense, '/api/data': unauthenticated });
  await app.run('start()');
  assert.ok(app.calls.some((c) => c.startsWith('/api/data')));
  assert.equal(app.run('state.user'), null);
  assert.match(app.appRoot.innerHTML, /login-form/);
});

test('retry after transient failure recovers bootstrap + license and hydrates the session even when state.user is null', async () => {
  let fail = true;
  const app = loadApp({
    '/api/bootstrap': () => (fail ? throwNetwork() : bootstrapOk()),
    '/api/license/status': () => (fail ? throwNetwork() : activeLicense()),
    '/api/data': unauthenticated,
  });
  await app.run('start()');
  assert.equal(app.run('state.license.status'), 'LICENSE_CHECK_RETRYABLE');
  fail = false;
  await app.run('retryLicenseStatusNow()');
  assert.equal(app.run('state.license.status'), 'ACTIVE');
  assert.equal(app.run('state.bootstrap.configured'), true);
  assert.ok(app.calls.some((c) => c.startsWith('/api/data')), 'session hydration must be attempted without state.user');
  assert.match(app.appRoot.innerHTML, /login-form/);
});

test('render() is fail-closed when license state is missing', () => {
  const app = loadApp({});
  app.run(`state.bootstrap = { configured: true, setupRequired: false, companyName: 'x', currency: 'EGP' }; state.license = null; render();`);
  assert.match(app.appRoot.innerHTML, /license-activation-screen/);
  assert.doesNotMatch(app.appRoot.innerHTML, /login-form/);
});
