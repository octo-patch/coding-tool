const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

// Execute the production CommonJS module, replacing only external state/services.
function loadModule(relativePath, replacements) {
  const filename = path.join(root, relativePath);
  const module = { exports: {} };
  const requireFromFile = createRequire(filename);
  const localRequire = (id) => Object.hasOwn(replacements, id)
    ? replacements[id] : requireFromFile(id);
  vm.runInThisContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(localRequire, module, module.exports);
  return module.exports;
}

async function loadPanel() {
  const context = vm.createContext({ URL });
  const presets = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/web/src/config/claudePresets.js'), 'utf8'), { context });
  const panel = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'src/web/src/components/channel/channelPanelFactories.js'), 'utf8'), { context });
  const names = ['getChannels', 'createChannel', 'updateChannel', 'deleteChannel', 'applyChannelToSettings', 'resetChannelHealth', 'testClaudeChannelSpeed', 'testCodexChannelSpeed', 'testGeminiChannelSpeed', 'getCodexChannels', 'createCodexChannel', 'updateCodexChannel', 'deleteCodexChannel', 'applyCodexChannelToSettings', 'resetCodexChannelHealth', 'getGeminiChannels', 'createGeminiChannel', 'updateGeminiChannel', 'deleteGeminiChannel', 'resetGeminiChannelHealth'];
  const calls = [];
  const api = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, (...args) => calls.push({ name, args }));
  }, { context });
  await panel.link((id) => id.includes('claudePresets') ? presets : api);
  await panel.evaluate();
  return { panel: panel.namespace.default.claude(), presets: presets.namespace.claudePresets, calls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('MiniMax presets reach settings and HTTP unchanged, preserving explicit models and history', async (t) => {
  const { panel, presets, calls } = await loadPanel();
  const files = new Map();
  const channels = loadModule('src/server/services/channels.js', {
    fs: {
      existsSync: (file) => files.has(file),
      mkdirSync: () => {},
      readFileSync: (file) => files.get(file),
      writeFileSync: (file, content) => files.set(file, content),
      watchFile: () => {}
    },
    os: { homedir: () => '/fixture-home' }
  });
  const settingsPath = '/fixture-home/.claude/settings.json';
  files.set(settingsPath, JSON.stringify({ env: { KEEP_ME: 'unchanged' }, permissions: { allow: [] } }));
  let selectedChannel;
  const captured = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      captured.push({ raw, url: req.url, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture-message', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await close(reservation);
  const noop = () => {};
  const proxy = loadModule('src/server/proxy-server.js', {
    './services/channel-scheduler': { allocateChannel: async () => selectedChannel, releaseChannel: noop, getSchedulerState: () => ({}) },
    './services/channel-health': { recordSuccess: noop, recordFailure: noop },
    './websocket-server': { broadcastLog: noop, broadcastSchedulerState: noop },
    '../config/loader': { loadConfig: () => ({ ports: { proxy: proxyPort } }) },
    './services/statistics-service': { recordRequest: noop },
    './services/proxy-runtime': { saveProxyStartTime: noop, clearProxyStartTime: noop }
  });
  await proxy.startProxyServer();
  t.after(() => proxy.stopProxyServer());

  async function send(payload) {
    const raw = JSON.stringify(payload, null, 2);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw
    });
    assert.equal(response.status, 200);
    await response.text();
    const outgoing = captured.at(-1);
    assert.equal(outgoing.raw, raw, 'the real HTTP proxy must preserve the complete serialized body');
    assert.equal(outgoing.url, '/anthropic/v1/messages');
    assert.equal(outgoing.headers['x-api-key'], 'fixture-only');
    assert.equal(outgoing.headers['anthropic-version'], '2023-06-01');
  }

  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect this image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Preserve this reasoning', signature: 'fixture-signature' }, { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'call-1', name: 'inspect', input: { file: 'sample' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] }
  ];
  const tools = [{ name: 'inspect', description: 'Inspect a file', input_schema: { type: 'object', properties: { file: { type: 'string' } } } }];
  for (const [id, baseUrl] of [['minimax', 'https://api.minimax.cn/anthropic'], ['minimax-global', 'https://api.minimax.io/anthropic']]) {
    await t.test(`${id}: selection, saved settings, default and effort HTTP payloads`, async () => {
      const form = panel.onPresetChange(id, panel.getInitialForm());
      form.apiKey = 'fixture-only';
      assert.equal(form.baseUrl, baseUrl);
      assert.deepEqual(plain(form.modelConfig), { model: 'MiniMax-M3.1-Flash', haikuModel: 'MiniMax-M3.1-Flash', sonnetModel: 'MiniMax-M3.1-Flash', opusModel: 'MiniMax-M3' });
      await panel.api.create(form);
      assert.equal(calls.at(-1).name, 'createChannel');
      const channel = channels.createChannel(...calls.at(-1).args);
      channels.applyChannelToSettings(channel.id);
      const settings = JSON.parse(files.get(settingsPath));
      assert.equal(settings.env.ANTHROPIC_BASE_URL, baseUrl);
      assert.equal(settings.env.ANTHROPIC_MODEL, 'MiniMax-M3.1-Flash');
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'MiniMax-M3');
      assert.equal(settings.env.KEEP_ME, 'unchanged');
      selectedChannel = { ...channel, baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic` };
      const payload = { model: settings.env.ANTHROPIC_MODEL, max_tokens: 4096, messages, tools };
      await send(payload);
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        await send({ ...payload, thinking: { type: 'adaptive' }, output_config: { effort } });
      }
      await send({ ...payload, model: settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL });
      await send({ ...payload, model: 'MiniMax-M3', thinking: { type: 'disabled' } });
      await send({ ...payload, model: 'MiniMax-M3', thinking: { type: 'adaptive' } });
    });
  }
  for (const model of ['MiniMax-M2.7', 'custom-model', 'claude-sonnet-4-5-20250929']) {
    await t.test(`saved model ${model} survives editing and transport`, async () => {
      const original = { id: 'saved', presetId: 'minimax', baseUrl: 'https://api.minimaxi.com/anthropic', modelConfig: { model, haikuModel: model, sonnetModel: model, opusModel: model } };
      const form = panel.mapChannelToForm(original);
      assert.deepEqual(plain(form.modelConfig), original.modelConfig);
      assert.equal(form.baseUrl, original.baseUrl);
      await panel.api.update(original, form);
      const saved = channels.createChannel('saved', form.baseUrl, 'fixture-only', '', { presetId: form.presetId, modelConfig: form.modelConfig });
      channels.applyChannelToSettings(saved.id);
      assert.equal(JSON.parse(files.get(settingsPath)).env.ANTHROPIC_MODEL, model);
      await send({ model, max_tokens: 4096, messages, tools });
    });
  }
  assert.deepEqual([...new Set(presets.filter((p) => p.id.startsWith('minimax')).flatMap((p) => Object.values(p.env)))], ['MiniMax-M3.1-Flash', 'MiniMax-M3']);
  assert.equal(captured.length, 21);
});
