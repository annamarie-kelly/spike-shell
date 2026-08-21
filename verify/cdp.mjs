// Zero-dependency Chrome DevTools Protocol client.
//
// Why hand-rolled: this worktree has no node_modules and installing
// Playwright/Puppeteer pulls a browser download. Node 22 ships a global
// WebSocket + fetch, and macOS already has Google Chrome - so we launch that
// headless with a debugging port and speak CDP directly. No deps, nothing to
// install, fully committable as a dev tool.
//
// Scope: just enough CDP to load a page, run script, dispatch real mouse/key
// input, and screenshot. The high-level driving API lives in harness.mjs.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('No Chrome/Chromium found in /Applications. Install Google Chrome.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launch headless Chrome, wait for its debugging port, return a Browser handle.
export async function launch({ headless = true } = {}) {
  const exe = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'spike-cdp-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--window-size=1400,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new', '--hide-scrollbars');
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore'] });

  // Chrome writes the chosen port to DevToolsActivePort once it's listening.
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const txt = readFileSync(portFile, 'utf8').split('\n');
      if (txt[0]) { port = Number(txt[0]); break; }
    }
    await sleep(50);
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome never reported a debugging port'); }

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const conn = new CDPConnection(ver.webSocketDebuggerUrl);
  await conn.ready();
  return new Browser(proc, conn, userDataDir);
}

// One websocket to the browser endpoint. CDP "flat" mode (sessionId on every
// message) lets a single socket carry browser- and page-level traffic.
class CDPConnection {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();        // id -> {resolve, reject}
    this.listeners = new Map();      // event method -> Set<fn>
    this._ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('CDP socket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }
  ready() { return this._ready; }
  _onMessage(data) {
    const msg = JSON.parse(data);
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.params || {})})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      const set = this.listeners.get(key);
      if (set) for (const fn of set) fn(msg.params);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, fn, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }
}

class Browser {
  constructor(proc, conn, userDataDir) {
    this.proc = proc;
    this.conn = conn;
    this.userDataDir = userDataDir;
  }
  // Open a fresh tab and attach to it (flat session).
  async newPage() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId, targetId);
    await page._init();
    return page;
  }
  async close() {
    try { await this.conn.send('Browser.close'); } catch {}
    try { this.proc.kill('SIGKILL'); } catch {}
    try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch {}
  }
}

class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleLines = [];
  }
  async _init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Log.enable');
    // collect console + page errors so a failed boot is visible, not silent.
    this.conn.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.consoleLines.push(`[${p.type}] ${text}`);
    }, this.sessionId);
    this.conn.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.consoleLines.push(`[exception] ${d.exception?.description || d.text}`);
    }, this.sessionId);
  }
  send(method, params) { return this.conn.send(method, params, this.sessionId); }
  on(method, fn) { return this.conn.on(method, fn, this.sessionId); }

  // Runs in every fresh document BEFORE its own scripts - the only way to seed
  // window state (e.g. __SPIKE_FIXTURES) ahead of the app's boot.
  async addInitScript(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async goto(url, { waitUntil = 'load', timeout = 15000 } = {}) {
    const done = new Promise((resolve) => {
      const off = this.on(waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', () => {
        off(); resolve();
      });
    });
    await this.send('Page.navigate', { url });
    await Promise.race([done, sleep(timeout)]);
  }

  async eval(fn, ...args) {
    const expression = typeof fn === 'string'
      ? fn
      : `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`;
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  async waitFor(predFn, { timeout = 8000, poll = 80 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.eval(predFn)) return true;
      await sleep(poll);
    }
    throw new Error('waitFor timed out: ' + String(predFn).slice(0, 120));
  }

  // Center viewport coords of the first element matching selector.
  async center(selector) {
    const r = await this.eval(function (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
    }, selector);
    if (!r) throw new Error('no element for selector: ' + selector);
    return r;
  }

  async mouse(type, x, y, { button = 'left', clickCount = 0 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button, buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
  }

  // A realistic drag: press, several intermediate moves (so threshold + live
  // tracking fire), release. steps controls smoothness.
  async drag(fromSel, toX, { steps = 14, settle = 260 } = {}) {
    const from = await this.center(fromSel);
    await this.mouse('mousePressed', from.x, from.y, { clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((toX - from.x) * i) / steps;
      await this.mouse('mouseMoved', x, from.y);
      await sleep(12);
    }
    await this.mouse('mouseReleased', toX, from.y, { clickCount: 1 });
    await sleep(settle);   // let the FLIP animation finish
  }

  // Type one printable character the way a keyboard does (keyDown carrying
  // `text`, then keyUp), so the page sees real beforeinput/input events and, in a
  // contenteditable, real caret movement. `insertText` below is the bulk version.
  async key(ch, { modifiers = 0 } = {}) {
    const common = { modifiers, key: ch, text: ch, unmodifiedText: ch };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(12);
  }

  // A named key (Enter, Escape, Backspace, …) with no text payload.
  async press(key, { code = key, modifiers = 0, windowsVirtualKeyCode = 0 } = {}) {
    const common = { modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(12);
  }

  // Commit text at the caret / over the selection, as an IME or a paste would.
  async insertText(text) {
    await this.send('Input.insertText', { text });
    await sleep(12);
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }
}

export { Browser, Page };
