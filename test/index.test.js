'use strict';

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Path to the module under test.
const INDEX_PATH = '../index.js';

// Build a complete set of mocks for every external dependency that index.js
// requires, then load index.js through proxyquire so no real network, device,
// browser, or filesystem interaction is ever needed.
function loadIndex(overrides = {}) {
  // --- wd mock -------------------------------------------------------------
  // index.js does `const { Webdriver } = require('wd')` and then patches
  // `Webdriver.prototype.percySnapshot`. We provide a fresh class each load so
  // tests never leak the patched prototype into one another.
  function Webdriver() {}
  const wdMock = { Webdriver };
  const wdPkgMock = { version: '1.14.0' };

  // --- jsdom mock ----------------------------------------------------------
  // The patched method does `new jsdom.JSDOM(html, { url })` and reads
  // `dom.window.document`. We let tests inspect the constructed document.
  const fakeDocument = overrides.fakeDocument || {
    documentElement: { outerHTML: '<html></html>' }
  };
  const jsdomCalls = [];
  function JSDOM(html, opts) {
    jsdomCalls.push({ html, opts });
    this.window = { document: fakeDocument };
  }
  const jsdomMock = { JSDOM };

  // --- @percy/agent mock ---------------------------------------------------
  // index.js: `const PercyAgent = require('@percy/agent').default` then
  // `new PercyAgent({...})` and `percyClient.snapshot(name, { document })`.
  const percyAgentInstances = [];
  class PercyAgent {
    constructor(config) {
      this.config = config;
      this.snapshot = sinon.stub().returns(overrides.domSnapshot || '<dom-snapshot/>');
      percyAgentInstances.push(this);
    }
  }
  const percyAgentMock = { default: PercyAgent, '@noCallThru': true };

  // --- @percy/agent sdk-utils mock ----------------------------------------
  // index.js: `const { postSnapshot } = require('@percy/agent/dist/utils/sdk-utils')`
  const postSnapshot = sinon
    .stub()
    .resolves(overrides.postSuccess === undefined ? true : overrides.postSuccess);
  const sdkUtilsMock = { postSnapshot, '@noCallThru': true };

  // --- slug mock -----------------------------------------------------------
  const slug = sinon.stub().callsFake((name) => String(name).replace(/\s+/g, '-'));
  const slugMock = Object.assign(slug, { '@noCallThru': true });

  // --- fs mock -------------------------------------------------------------
  const fsMock = {
    existsSync: sinon.stub().returns(overrides.dirExists === undefined ? true : overrides.dirExists),
    mkdirSync: sinon.stub(),
    writeFileSync: sinon.stub()
  };

  // --- path mock (pass-through-ish, but deterministic) ---------------------
  const pathMock = {
    join: sinon.stub().callsFake((...parts) => parts.join('/'))
  };

  const index = proxyquire(INDEX_PATH, {
    fs: fsMock,
    path: pathMock,
    slug: slugMock,
    jsdom: jsdomMock,
    wd: wdMock,
    'wd/package.json': wdPkgMock,
    '@percy/agent': percyAgentMock,
    '@percy/agent/dist/utils/sdk-utils': sdkUtilsMock
  });

  return {
    index,
    Webdriver,
    mocks: {
      postSnapshot,
      slug: slugMock,
      fs: fsMock,
      path: pathMock,
      jsdomCalls,
      percyAgentInstances,
      fakeDocument
    }
  };
}

// Create a driver instance whose prototype carries the patched percySnapshot,
// with stubbed device interactions.
function makeDriver(Webdriver, opts = {}) {
  const driver = Object.create(Webdriver.prototype);
  driver.sessionCapabilities = sinon
    .stub()
    .resolves(opts.capabilities || { deviceName: 'iPhone 13' });
  driver.getWindowSize = sinon
    .stub()
    .resolves(opts.dimensions || { width: 390, height: 844 });
  driver.takeScreenshot = sinon
    .stub()
    .resolves(opts.screenshot === undefined ? 'BASE64 \r\n DATA' : opts.screenshot);
  return driver;
}

describe('@percy/appium-wd', () => {
  let consoleLog;
  let consoleWarning;
  let originalLogLevel;

  beforeEach(() => {
    consoleLog = sinon.stub(console, 'log');
    // index.js calls console.warning (a bug that should not be "fixed" by us);
    // it is undefined on console, so we add a stub to keep that branch runnable
    // and to assert on it without changing runtime behavior of index.js.
    consoleWarning = sinon.stub();
    console.warning = consoleWarning;
    originalLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    sinon.restore();
    delete console.warning;
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('patches Webdriver.prototype.percySnapshot on require', () => {
    const { Webdriver } = loadIndex();
    assert.strictEqual(typeof Webdriver.prototype.percySnapshot, 'function');
    assert.strictEqual(Webdriver.prototype.percySnapshot.name, 'percySnapshot');
  });

  it('takes a snapshot on the happy path (no options)', async () => {
    const { Webdriver, mocks } = loadIndex();
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('Home Screen');

    // Screenshot whitespace/newlines are stripped before embedding.
    const { html } = mocks.jsdomCalls[0];
    assert.ok(html.includes("data:image/png;base64,BASE64DATA"));
    assert.ok(html.includes('<title>Home Screen</title>'));

    // JSDOM constructed with the required URL.
    assert.strictEqual(mocks.jsdomCalls[0].opts.url, 'http://localhost');

    // PercyAgent constructed with client/environment info and agent comm off.
    const agent = mocks.percyAgentInstances[0];
    assert.strictEqual(agent.config.handleAgentCommunication, false);
    assert.match(agent.config.clientInfo, /^@percy\/appium-wd\//);
    assert.strictEqual(agent.config.environmentInfo, 'wd/1.14.0');
    assert.ok(agent.snapshot.calledOnceWith('Home Screen'));

    // postSnapshot called with the expected payload.
    assert.ok(mocks.postSnapshot.calledOnce);
    const payload = mocks.postSnapshot.firstCall.args[0];
    assert.strictEqual(payload.name, 'Home Screen');
    assert.strictEqual(payload.domSnapshot, '<dom-snapshot/>');
    assert.strictEqual(payload.url, 'http://localhost/');
    assert.deepStrictEqual(payload.widths, [390]);
    assert.strictEqual(payload.minHeight, 844);
    assert.strictEqual(payload.percyCSS, undefined);

    // No error logged when post succeeds; no debug write without LOG_LEVEL.
    assert.ok(consoleLog.notCalled);
    assert.ok(mocks.fs.writeFileSync.notCalled);
  });

  it('HTML-escapes special characters in the snapshot name before injecting it into <title>', async () => {
    const { Webdriver, mocks } = loadIndex();
    const driver = makeDriver(Webdriver);

    const malicious = `</title><script>alert('xss')</script> & "quoted"`;
    await driver.percySnapshot(malicious);

    const { html } = mocks.jsdomCalls[0];
    // The raw markup-breaking characters must not survive into the document.
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('</title><script>'));
    // Each special character is entity-encoded inside the title.
    assert.ok(
      html.includes(
        '<title>&lt;/title&gt;&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt; &amp; &quot;quoted&quot;</title>'
      )
    );

    // The original, unescaped name is still used for the snapshot payload and
    // PercyAgent call (escaping is presentation-only, scoped to the markup).
    const payload = mocks.postSnapshot.firstCall.args[0];
    assert.strictEqual(payload.name, malicious);
    assert.ok(mocks.percyAgentInstances[0].snapshot.calledOnceWith(malicious));
  });

  it('appends the device name when appendDeviceName is set', async () => {
    const { Webdriver, mocks } = loadIndex();
    const driver = makeDriver(Webdriver, { capabilities: { deviceName: 'Pixel 6' } });

    await driver.percySnapshot('Login', { appendDeviceName: true });

    assert.ok(driver.sessionCapabilities.calledOnce);
    const payload = mocks.postSnapshot.firstCall.args[0];
    assert.strictEqual(payload.name, 'Login [Pixel 6]');
    const { html } = mocks.jsdomCalls[0];
    assert.ok(html.includes('<title>Login [Pixel 6]</title>'));
  });

  it('does not query capabilities when appendDeviceName is falsy', async () => {
    const { Webdriver } = loadIndex();
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('No Device');

    assert.ok(driver.sessionCapabilities.notCalled);
  });

  it('warns and includes customCss when the deprecated option is used', async () => {
    const { Webdriver, mocks } = loadIndex();
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('Styled', { customCss: 'margin: 10px;' });

    // Deprecation warning emitted via console.warning for the named snapshot.
    assert.ok(consoleWarning.calledOnce);
    assert.match(consoleWarning.firstCall.args[0], /customCss.*deprecated.*Styled/s);

    // customCss flows into the inline style of the rendered div.
    const { html } = mocks.jsdomCalls[0];
    assert.ok(html.includes('margin: 10px;'));
  });

  it('passes percyCSS through to postSnapshot', async () => {
    const { Webdriver, mocks } = loadIndex();
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('CSS', { percyCSS: '.foo { color: red; }' });

    const payload = mocks.postSnapshot.firstCall.args[0];
    assert.strictEqual(payload.percyCSS, '.foo { color: red; }');
    // No customCss => no deprecation warning.
    assert.ok(consoleWarning.notCalled);
  });

  it('logs an error when posting the snapshot fails', async () => {
    const { Webdriver } = loadIndex({ postSuccess: false });
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('Fails');

    assert.ok(consoleLog.calledOnceWith('[percy] Error posting snapshot to agent.'));
  });

  it('writes a debug snapshot to disk when LOG_LEVEL is debug', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { Webdriver, mocks } = loadIndex({ dirExists: false });
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('Debug Me');

    // Directory missing => created.
    assert.ok(mocks.fs.existsSync.calledOnce);
    assert.ok(mocks.fs.mkdirSync.calledOnce);

    // File written with the slugged name and the document outerHTML.
    assert.ok(mocks.slug.calledOnceWith('Debug Me'));
    assert.ok(mocks.fs.writeFileSync.calledOnce);
    const [snapshotPath, contents] = mocks.fs.writeFileSync.firstCall.args;
    assert.ok(snapshotPath.endsWith('Debug-Me.html'));
    assert.strictEqual(contents, '<html></html>');

    // Confirms the "written to" log line ran.
    assert.ok(consoleLog.calledWithMatch(/Percy debug snapshot written to/));
  });

  it('does not recreate the debug dir when it already exists', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { Webdriver, mocks } = loadIndex({ dirExists: true });
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('Existing Dir');

    assert.ok(mocks.fs.existsSync.calledOnce);
    assert.ok(mocks.fs.mkdirSync.notCalled);
    assert.ok(mocks.fs.writeFileSync.calledOnce);
  });

  it('writes a falsy body when documentElement is missing', async () => {
    process.env.LOG_LEVEL = 'debug';
    // documentElement absent exercises the left-hand short-circuit of
    // `document.documentElement && document.documentElement.outerHTML`.
    const { Webdriver, mocks } = loadIndex({
      dirExists: true,
      fakeDocument: { documentElement: null }
    });
    const driver = makeDriver(Webdriver);

    await driver.percySnapshot('No Doc Element');

    const [, contents] = mocks.fs.writeFileSync.firstCall.args;
    assert.strictEqual(contents, null);
  });
});
