'use strict';

/**
 * Mount tests for the bridge plugin: it must load on a minimal Cordis-like
 * context, wire the seven host events, register `/sts` exactly once, keep the
 * guard inert until a directive is armed, and give every registration back on
 * dispose.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../lib/bridge.cjs');

/** A throwaway state directory for one test. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sts-bridge-test-'));
}

/** One verified user message, as the harness builds it. */
function userMessage(text) {
  return { id: `msg-${Math.random().toString(16).slice(2)}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** The decision `next()` returns for one waterfall, per the host defaults. */
const NEXT = {
  'agent/pre-step': async () => ({ kind: 'enter', messages: [] }),
  'tools/pre-execute': async () => ({ kind: 'allow' }),
  'tools/post-execute': async () => ({ kind: 'accept' })
};

/** Read the single persisted session state, whose file name is a hash. */
function readOnlyState(dataDir) {
  const directory = path.join(dataDir, 'sessions');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1, `one session state file in ${directory}`);
  return JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
}

/**
 * A minimal context: event listeners, effects, `inject`, and the `sessions`
 * service the plugin declares in its own `inject` list.
 */
function mountContext(sessions) {
  const listeners = new Map();
  const effects = [];
  const injectedDeps = [];
  const unregistered = [];
  const ctx = {
    sessions: {
      get: (id) => sessions.get(id)
    },
    get(serviceName) {
      if (serviceName === 'sessions') return ctx.sessions;
      if (serviceName === 'agents') return { get: () => undefined, currentInitiator: () => undefined };
      return undefined;
    },
    on(event, handler) {
      listeners.set(event, (listeners.get(event) || []).concat(handler));
      return () => {};
    },
    effect(register) {
      const dispose = register();
      effects.push(dispose);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    inject(deps, callback) {
      injectedDeps.push(deps);
      callback({
        commands: {
          register: (definition) => () => { unregistered.push(definition.name); }
        }
      });
      return { dispose() {} };
    },
    logger: { info() {} }
  };
  return { ctx, listeners, effects, injectedDeps, unregistered };
}

/** Invoke every listener of one event in order. */
function emit(listeners, event, ...args) {
  const handlers = listeners.get(event) || [];
  assert.ok(handlers.length > 0, `no listener registered for ${event}`);
  return handlers.reduce((previous, handler) => previous.then(() => handler(...args)), Promise.resolve()).then(() => undefined);
}

/** Directly await the single listener of a waterfall event. */
function call(listeners, event, ...args) {
  const handlers = listeners.get(event) || [];
  assert.equal(handlers.length, 1, `expected one listener for ${event}`);
  return handlers[0](...args);
}

/** The gate context the plugin builds for one tool execution. */
function toolExecution(callId, name, toolArguments, cwd, sessionId) {
  return { callId, name, arguments: toolArguments, agent: { session: { id: sessionId, header: { cwd } } } };
}

test('the bridge exports a Cordis object plugin', () => {
  assert.equal(bridge.name, 'stop-that-shit');
  assert.deepEqual(bridge.inject, ['sessions']);
  assert.equal(typeof bridge.apply, 'function');
  assert.equal(bridge.default, bridge);
});

test('mounting wires every host event and the /sts command', () => {
  const { ctx, listeners, effects, injectedDeps } = mountContext(new Map());
  assert.doesNotThrow(() => bridge.apply(ctx, { dataDir: tempDir() }));
  for (const event of [
    'session/created',
    'session/disposed',
    'agent/pre-step',
    'tools/pre-execute',
    'tools/post-execute',
    'subagent/start',
    'subagent/end'
  ]) {
    assert.equal((listeners.get(event) || []).length, 1, `${event} listener`);
  }
  assert.equal(effects.length, 1);
  assert.deepEqual(injectedDeps, [['commands']]);
});

test('dispose gives every registration back', () => {
  const { ctx, effects, unregistered } = mountContext(new Map());
  bridge.apply(ctx, { dataDir: tempDir() });
  for (const dispose of effects) dispose();
  assert.deepEqual(unregistered, ['sts']);
});

test('the guard stays inert until a directive is armed', async () => {
  const dataDir = tempDir();
  const sessionId = 'root-inert';
  const cwd = process.cwd();
  const { ctx, listeners } = mountContext(new Map([[sessionId, { id: sessionId, header: { cwd } }]]));
  bridge.apply(ctx, { dataDir });

  const stepped = await call(listeners, 'agent/pre-step', {
    agent: { session: { id: sessionId, header: { cwd } } },
    messages: [userMessage('write the report')],
    turn: 1,
    step: 1
  }, NEXT['agent/pre-step']);
  // Without a directive the contract stays unconfirmed: the step is admitted and
  // the plugin only appends its advisory context, as an ordinary user message.
  assert.equal(stepped.kind, 'enter');
  assert.equal(stepped.messages.length, 1);
  assert.equal(stepped.messages[0].role, 'user');
  assert.equal(stepped.messages[0].source.kind, 'stop-that-shit');
  assert.match(stepped.messages[0].content[0].text, /watch-only mode/);

  const decision = await call(listeners, 'tools/pre-execute', toolExecution('call-1', 'write', { file_path: 'docs/report.md', content: 'x' }, cwd, sessionId), NEXT['tools/pre-execute']);
  assert.deepEqual(decision, { kind: 'allow' });

  const state = readOnlyState(dataDir);
  assert.equal(state.contract.mode, 'unconfirmed');
  assert.equal(state.contract.level, 'watch');
});

test('an armed directive denies a call outside its file boundary', async () => {
  const dataDir = tempDir();
  const sessionId = 'root-armed';
  const cwd = process.cwd();
  const { ctx, listeners } = mountContext(new Map([[sessionId, { id: sessionId, header: { cwd } }]]));
  bridge.apply(ctx, { dataDir });

  const armed = await call(listeners, 'agent/pre-step', {
    agent: { session: { id: sessionId, header: { cwd } } },
    messages: [userMessage('$stop-that-shit change lock files=src/** -- tighten the parser')],
    turn: 1,
    step: 1
  }, NEXT['agent/pre-step']);
  assert.equal(armed.kind, 'enter');
  assert.equal(armed.messages.length, 1);
  assert.equal(armed.messages[0].source.kind, 'stop-that-shit');

  // The contract is persisted under the configured state directory.
  const state = readOnlyState(dataDir);
  assert.equal(state.contract.level, 'lock');
  assert.equal(state.contract.mode, 'change');
  assert.deepEqual(state.contract.allowedPaths, ['src/**']);

  const inside = await call(listeners, 'tools/pre-execute', toolExecution('call-in', 'write', { file_path: 'src/a.js', content: 'x' }, cwd, sessionId), NEXT['tools/pre-execute']);
  assert.deepEqual(inside, { kind: 'allow' });

  const denied = await call(listeners, 'tools/pre-execute', toolExecution('call-out', 'write', { file_path: 'docs/report.md', content: 'x' }, cwd, sessionId), NEXT['tools/pre-execute']);
  assert.equal(denied.kind, 'deny');
  assert.equal(typeof denied.reason, 'string');

  // The harness still runs post-execute for the synthesized denial result.
  const passthrough = await call(listeners, 'tools/post-execute', toolExecution('call-out', 'write', { file_path: 'docs/report.md', content: 'x' }, cwd, sessionId), { isError: true, content: [] }, NEXT['tools/post-execute']);
  assert.deepEqual(passthrough, { kind: 'accept' });
});

test('lifecycle and subagent events are observed without throwing', async () => {
  const dataDir = tempDir();
  const parentId = 'root-parent';
  const childId = 'child-session';
  const sessions = new Map([
    [parentId, { id: parentId, header: { cwd: process.cwd() } }],
    [childId, { id: childId, header: { cwd: process.cwd(), parentSession: parentId } }]
  ]);
  const { ctx, listeners } = mountContext(sessions);
  bridge.apply(ctx, { dataDir });

  await emit(listeners, 'session/created', { id: parentId, header: {} });
  await emit(listeners, 'subagent/start', { runId: 'run-1', provider: 'in-process', id: childId, local: true });
  await emit(listeners, 'subagent/end', { runId: 'run-1', provider: 'in-process', id: childId, local: true, stopReason: 'complete' });
  await emit(listeners, 'session/disposed', { id: childId, header: {} });

  const parentState = readOnlyState(dataDir);
  assert.ok(parentState.delegation, 'the parent ledger exists');
  assert.deepEqual(parentState.delegation.reservations, {}, 'the finished child left no reservation');
});