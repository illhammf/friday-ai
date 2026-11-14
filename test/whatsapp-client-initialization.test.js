import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const { exposeFunctionIfAbsent } = require('../node_modules/whatsapp-web.js/src/util/Puppeteer.js');

function loadWhatsAppClientWithFakePuppeteer(fakePuppeteer) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'puppeteer') return fakePuppeteer;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../node_modules/whatsapp-web.js/src/Client.js');
  } finally {
    Module._load = originalLoad;
  }
}

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.primaryFrame = { url: () => 'https://web.whatsapp.com/' };
    this.windowBindings = new Set();
    this.registeredBindings = new Set();
    this.exposeCalls = 0;
  }

  async setUserAgent() {}
  async goto() {}
  async evaluateOnNewDocument() {}
  async evaluate(callback, name) {
    if (typeof callback === 'function') return this.windowBindings.has(name);
    return false;
  }
  async exposeFunction(name) {
    this.exposeCalls += 1;
    if (this.registeredBindings.has(name)) {
      throw new Error(`Failed to add page binding with name ${name}: window['${name}'] already exists!`);
    }
    this.registeredBindings.add(name);
    this.windowBindings.add(name);
  }
  async waitForFunction(_callback, _options, name) {
    this.windowBindings.add(name);
  }
  mainFrame() { return this.primaryFrame; }
}

test('waits for an existing Puppeteer binding instead of registering it twice', async () => {
  const page = new FakePage();
  page.registeredBindings.add('onQRChangedEvent');

  await exposeFunctionIfAbsent(page, 'onQRChangedEvent', () => {});

  assert.equal(page.exposeCalls, 1);
  assert.equal(page.windowBindings.has('onQRChangedEvent'), true);
});

test('does not mask unrelated Puppeteer exposeFunction errors', async () => {
  const page = new FakePage();
  page.exposeFunction = async () => { throw new Error('protocol failure'); };

  await assert.rejects(
    exposeFunctionIfAbsent(page, 'onQRChangedEvent', () => {}),
    /protocol failure/,
  );
});

test('whatsapp-web.js reinjects once per main-frame navigation and coalesces overlap', async () => {
  const page = new FakePage();
  const browser = { pages: async () => [page] };
  const fakePuppeteer = { launch: async () => browser };
  const Client = loadWhatsAppClientWithFakePuppeteer(fakePuppeteer);
  const authStrategy = {
    setup() {},
    beforeBrowserInitialized: async () => {},
    afterBrowserInitialized: async () => {},
    afterAuthReady: async () => {},
    logout: async () => {},
  };
  const client = new Client({ authStrategy });
  let initializeCalls = 0;
  let releaseReinjection;
  const reinjectionGate = new Promise((resolve) => { releaseReinjection = resolve; });
  client.initWebVersionCache = async () => {};
  client.inject = async () => {
    initializeCalls += 1;
    await exposeFunctionIfAbsent(page, 'onQRChangedEvent', () => {});
    if (initializeCalls === 2) await reinjectionGate;
  };

  await client.initialize();
  assert.equal(initializeCalls, 1);
  assert.equal(page.listenerCount('framenavigated'), 1);

  const subframe = { url: () => 'https://web.whatsapp.com/embedded-frame' };
  page.emit('framenavigated', subframe);
  assert.equal(initializeCalls, 1);

  page.emit('framenavigated', page.primaryFrame);
  page.emit('framenavigated', page.primaryFrame);
  assert.equal(initializeCalls, 2);
  releaseReinjection();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializeCalls, 2);

  page.emit('framenavigated', page.primaryFrame);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializeCalls, 3);
  assert.equal(page.listenerCount('framenavigated'), 1);
  assert.equal(page.exposeCalls, 1);
});
