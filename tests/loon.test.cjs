const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/location-spoofer.js'), 'utf8');
const api = require('../public/location-spoofer.js');

// A WLOC response containing one Wi-Fi location and an unrelated field.
const location = api.concatBytes([
  api.makeVarintField(1, 3100000000),
  api.makeVarintField(2, 12100000000),
  api.makeVarintField(3, 80),
  api.makeVarintField(4, 123)
]);
const fixture = api.buildSyntheticResponse(api.concatBytes([
  api.makeLengthDelimitedField(2, api.makeLengthDelimitedField(2, location)),
  api.makeVarintField(33, 99)
]));

function runRuntime({ loon = true, argument = '', body = fixture, remote } = {}) {
  const completions = [];
  const requests = [];
  const logs = [];
  const context = {
    Uint8Array, ArrayBuffer,
    console: { log: message => logs.push(message) },
    $request: { url: 'https://gs-loc.apple.com/clls/wloc' },
    $response: { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body },
    $argument: argument,
    $done: result => completions.push(result),
    $httpClient: {
      get(options, callback) {
        requests.push(options);
        queueMicrotask(() => {
          if (remote && remote.error) callback(remote.error, null, null);
          else callback(null, { status: remote?.status || 200 }, remote?.data || '');
        });
      }
    }
  };
  if (loon) context.$loon = 'iPhone 18.0 3.5.1';
  vm.runInNewContext(source, context);
  return { completions, requests, logs };
}

function readLocation(body) {
  const payload = api.extractEnvelope(body).payload;
  const fields = api.parseFields(payload);
  assert.equal(fields.find(f => f.fieldNumber === 33).int64Value, 99);
  const wifi = api.parseFields(fields.find(f => f.fieldNumber === 2).valueBytes);
  const loc = api.parseFields(wifi.find(f => f.fieldNumber === 2).valueBytes);
  return Object.fromEntries(loc.map(f => [f.fieldNumber, f.int64Value]));
}

test('Loon returns a flat binary response with rewritten coordinates and preserved fields', () => {
  const { completions } = runRuntime({ argument: 'latitude=-33.86&longitude=151.21&horizontalAccuracy=12' });
  assert.equal(completions.length, 1);
  const result = completions[0];
  assert.equal(result.response, undefined);
  assert.equal(result.status, 200);
  assert.ok(result.body instanceof Uint8Array);
  assert.equal(result.headers['Content-Type'], 'application/octet-stream');
  assert.equal(result.headers['Content-Length'], String(result.body.length));
  assert.equal(result.headers['X-Location-Spoofer-Wifi'], '1');
  assert.deepEqual(readLocation(result.body), { 1: -3386000000, 2: 15121000000, 3: 12, 4: 123 });
});

test('Loon waits for remote coordinates and uses a five-second HTTP timeout in milliseconds', async () => {
  const configUrl = 'https://example.com/loc.json?token=a%26b%3Dc';
  const { completions, requests } = runRuntime({
    argument: 'configUrl=' + configUrl,
    remote: { data: JSON.stringify({ latitude: 22.3, longitude: 114.2, horizontalAccuracy: 9 }) }
  });
  assert.equal(completions.length, 0);
  await Promise.resolve();
  assert.equal(requests[0].url, configUrl);
  assert.equal(requests[0].timeout, 5000);
  assert.equal(completions.length, 1);
  assert.deepEqual(readLocation(completions[0].body), { 1: 2230000000, 2: 11420000000, 3: 9, 4: 123 });
});

test('Shadowrocket preserves its nested response and timeout contract', async () => {
  const { completions, requests } = runRuntime({
    loon: false,
    argument: 'configUrl=https://example.com/loc.json?token=test',
    remote: { data: JSON.stringify({ latitude: 40, longitude: 116 }) }
  });
  await Promise.resolve();
  assert.equal(requests[0].timeout, 5);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].body, undefined);
  const response = completions[0].response;
  assert.equal(response.status, 200);
  assert.deepEqual(readLocation(response.body), { 1: 4000000000, 2: 11600000000, 3: 39, 4: 123 });
});

test('remote failures keep the existing local-argument fallback', async () => {
  for (const remote of [{ error: 'timeout' }, { status: 401, data: '{}' }, { data: 'invalid JSON' }]) {
    const { completions } = runRuntime({
      argument: 'latitude=10&longitude=20&configUrl=https://example.com/loc.json', remote
    });
    await Promise.resolve();
    assert.equal(completions.length, 1);
    assert.deepEqual(readLocation(completions[0].body), { 1: 1000000000, 2: 2000000000, 3: 39, 4: 123 });
  }
});

test('invalid and empty response bodies pass through once; failOpen=false returns a client-specific error', () => {
  for (const loon of [true, false]) {
    for (const body of [new Uint8Array(0), new Uint8Array([255, 255])]) {
      const { completions } = runRuntime({ loon, body });
      assert.equal(completions.length, 1);
      assert.equal(Object.keys(completions[0]).length, 0);
    }
    const { completions } = runRuntime({ loon, body: new Uint8Array([255, 255]), argument: 'failOpen=false' });
    assert.equal(completions.length, 1);
    const response = loon ? completions[0] : completions[0].response;
    assert.equal(response.status, loon ? 500 : 'HTTP/1.1 500 Internal Server Error');
    assert.match(response.body, /^Location spoofing failed:/);
  }
});

test('both distributed runtime copies stay identical', () => {
  assert.equal(fs.readFileSync(path.join(root, 'location-spoofer.js'), 'utf8'), source);
});

for (const extension of ['plugin', 'sgmodule']) {
  test(`${extension} endpoint renders the deployment host and URL-encoded token`, async () => {
    const { onRequestGet } = await import(pathToFileURL(path.join(root, `functions/ios-location-spoofer.${extension}.js`)));
    const template = fs.readFileSync(path.join(root, `public/ios-location-spoofer.${extension}`), 'utf8');
    for (const token of ['', 'plain-token', 'a&b=c, d"#中文/$&']) {
      const request = new Request('https://example.com/ios-location-spoofer.' + extension + '?token=' + encodeURIComponent(token));
      const response = await onRequestGet({ request, env: { ASSETS: { fetch: async req => {
        assert.equal(req, request);
        return new Response(template);
      } } } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match(response.headers.get('Content-Type'), /text\/plain/);
      const content = await response.text();
      assert.doesNotMatch(content, /你的域名|你的Token/);
      assert.ok(content.includes('https://example.com/location-spoofer.js'));
      const argument = content.match(/argument="?([^"\r\n]+)/)[1];
      const configUrl = api.parseArgumentString(argument).configUrl;
      assert.equal(new URL(configUrl).searchParams.get('token'), token);
      if (extension === 'plugin') {
        assert.ok(content.includes('binary-body-mode=true'));
        assert.ok(content.includes('requires-body=true'));
        assert.doesNotMatch(content, /%APPEND%/);
        const pattern = new RegExp(content.match(/^http-response (\S+)/m)[1]);
        for (const host of ['gs-loc.apple.com', 'gs-loc-cn.apple.com', 'gsp-ssl.ls.apple.com', 'bluedot.is.autonavi.com', 'bluedot.is.autonavi.com.gds.alibabadns.com']) {
          assert.ok(pattern.test(`https://${host}/clls/wloc?test=1`));
        }
        assert.equal(pattern.test('https://example.com/clls/wloc'), false);
        assert.equal(pattern.test('https://gs-loc.apple.com/other'), false);
      }
    }
    const missing = await onRequestGet({ request: new Request('https://example.com/missing'), env: { ASSETS: { fetch: async () => new Response('', { status: 404 }) } } });
    assert.equal(missing.status, 404);
  });

  test(`${extension} subscription debug parameter controls runtime logging`, async () => {
    const { onRequestGet } = await import(pathToFileURL(path.join(root, `functions/ios-location-spoofer.${extension}.js`)));
    const template = fs.readFileSync(path.join(root, `public/ios-location-spoofer.${extension}`), 'utf8');
    for (const debug of [undefined, 'false', 'true', '1', 'TRUE', 'true&failOpen=false']) {
      const url = new URL(`https://example.com/ios-location-spoofer.${extension}`);
      url.searchParams.set('token', 'a&b=中文');
      if (debug !== undefined) url.searchParams.set('debug', debug);
      const response = await onRequestGet({
        request: new Request(url), env: { ASSETS: { fetch: async () => new Response(template) } }
      });
      assert.equal(response.status, 200);
      const content = await response.text();
      const argument = content.match(/argument="?([^"\r\n]+)/)[1];
      const args = api.parseArgumentString(argument);
      const enabled = debug === 'true';
      assert.equal(args.debug, String(enabled));
      assert.equal(args.failOpen, undefined);
      assert.equal(new URL(args.configUrl).searchParams.get('token'), 'a&b=中文');
      assert.equal(new URL(args.configUrl).searchParams.has('debug'), false);
      const { logs, completions } = runRuntime({ loon: extension === 'plugin', argument });
      await Promise.resolve();
      assert.equal(completions.length, 1);
      assert.equal(logs.some(line => line.includes('[Location Spoofer] Patched ')), enabled);
    }
  });
}

test('configuration panel groups each client with its own argument display and copy action', async () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const client of ['shadowrocket', 'loon']) {
    const group = html.match(new RegExp(`<section id="config-${client}-section"[^>]*>([\\s\\S]*?)</section>`));
    assert.ok(group, `Missing ${client} configuration section`);
    assert.ok(group[1].includes(`id="config-${client}-arg-text"`));
    assert.ok(group[1].includes(`id="btn-${client}-copy-arg"`));
    assert.ok(group[1].includes(`id="config-${client}-debug"`));
    const otherClient = client === 'loon' ? 'shadowrocket' : 'loon';
    assert.ok(!group[1].includes(`id="config-${otherClient}-arg-text"`));
  }
  assert.ok(!html.includes('id="config-arg-text"'));
  const section = html.slice(html.indexOf('var configPanelOpen = false;'), html.indexOf('// Click overlay closes everything'));
  const elements = new Map();
  const copied = [];
  const element = id => {
    assert.ok(html.includes(`id="${id}"`), `Missing element ${id}`);
    if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {}, remove() {} }, addEventListener(type, fn) { this[type] = fn; } });
    return elements.get(id);
  };
  const token = 'a&b=c 中文';
  const storage = new Map([['gps_token', token]]);
  const context = {
    $id: element, window: { location: { origin: 'https://example.com', href: '' } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    elOverlay: { classList: { add() {}, remove() {} } }, favPanelOpen: false,
    navigator: { clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } } },
    toast() {}
  };
  vm.runInNewContext(section, context);
  context.openConfigPanel();
  const loonUrl = element('config-loon-url-text').textContent;
  assert.equal(new URL(loonUrl).pathname, '/ios-location-spoofer.plugin');
  assert.equal(new URL(loonUrl).searchParams.get('token'), token);
  assert.equal(new URL(loonUrl).searchParams.get('debug'), 'false');
  element('btn-loon-import').click();
  assert.equal(context.window.location.href, 'loon://import?plugin=' + encodeURIComponent(loonUrl));
  element('btn-loon-copy-url').click();
  await Promise.resolve();
  assert.equal(copied[0], loonUrl);
  element('btn-config-import').click();
  const shadowUrl = element('config-url-text').textContent;
  assert.equal(context.window.location.href, 'shadowrocket://install/module?url=' + encodeURIComponent(shadowUrl));
  assert.equal(new URL(shadowUrl).pathname, '/ios-location-spoofer.sgmodule');
  const expectedArgument = 'configUrl=https://example.com/loc.json?token=' + encodeURIComponent(token) + '&debug=false';
  for (const client of ['shadowrocket', 'loon']) {
    assert.equal(element(`config-${client}-arg-text`).textContent, expectedArgument);
    // Distinct contents prove each copy button reads its own client's display.
    const argument = expectedArgument.replace('debug=false', 'debug=' + (client === 'loon'));
    element(`config-${client}-arg-text`).textContent = argument;
    element(`btn-${client}-copy-arg`).click();
    await Promise.resolve();
    assert.equal(copied.at(-1), argument);
  }

  const loonToggle = element('config-loon-debug');
  const shadowrocketToggle = element('config-shadowrocket-debug');
  loonToggle.checked = true;
  loonToggle.change();
  const debugLoonUrl = element('config-loon-url-text').textContent;
  assert.equal(new URL(debugLoonUrl).searchParams.get('debug'), 'true');
  assert.equal(new URL(debugLoonUrl).searchParams.get('token'), token);
  assert.equal(new URL(element('config-url-text').textContent).searchParams.get('debug'), 'false');
  assert.equal(element('config-loon-arg-text').textContent, expectedArgument.replace('debug=false', 'debug=true'));
  assert.equal(element('config-shadowrocket-arg-text').textContent, expectedArgument);
  element('btn-loon-import').click();
  assert.equal(context.window.location.href, 'loon://import?plugin=' + encodeURIComponent(debugLoonUrl));
  element('btn-loon-copy-url').click();
  await Promise.resolve();
  assert.equal(copied.at(-1), debugLoonUrl);
  assert.equal(storage.get('gps_debug_loon'), 'true');

  shadowrocketToggle.checked = true;
  shadowrocketToggle.change();
  const debugShadowrocketUrl = element('config-url-text').textContent;
  assert.equal(new URL(debugShadowrocketUrl).searchParams.get('debug'), 'true');
  assert.equal(element('config-shadowrocket-arg-text').textContent, expectedArgument.replace('debug=false', 'debug=true'));
  element('btn-config-import').click();
  assert.equal(context.window.location.href, 'shadowrocket://install/module?url=' + encodeURIComponent(debugShadowrocketUrl));
  element('btn-config-copy-url').click();
  await Promise.resolve();
  assert.equal(copied.at(-1), debugShadowrocketUrl);

  context.closeConfigPanel();
  loonToggle.checked = false;
  shadowrocketToggle.checked = false;
  context.openConfigPanel();
  assert.equal(loonToggle.checked, true);
  assert.equal(shadowrocketToggle.checked, true);
  loonToggle.checked = false;
  loonToggle.change();
  assert.equal(storage.get('gps_debug_loon'), 'false');
  assert.equal(storage.get('gps_debug_shadowrocket'), 'true');
  assert.equal(new URL(element('config-loon-url-text').textContent).searchParams.get('debug'), 'false');

  storage.delete('gps_token');
  context.openConfigPanel();
  for (const id of ['config-url-text', 'config-loon-url-text']) {
    const url = new URL(element(id).textContent);
    assert.equal(url.searchParams.has('token'), false);
    assert.equal([...url.searchParams.keys()].join(','), 'debug');
  }
  assert.equal(element('config-loon-arg-text').textContent, 'configUrl=https://example.com/loc.json&debug=false');
  assert.equal(element('config-shadowrocket-arg-text').textContent, 'configUrl=https://example.com/loc.json&debug=true');
});
