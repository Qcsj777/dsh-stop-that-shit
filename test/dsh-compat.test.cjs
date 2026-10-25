'use strict';

/**
 * Tests for the DSH compatibility layer (`lib/dsh-compat.cjs`): the payload
 * mappings that make the vendored adapter work on DeepSeek Harness 0.2.1-rc.2,
 * and the `/sts` command.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { adapter, parentSessionOf, parseStsInput, registerCommands } = require('../lib/dsh-compat.cjs');

/** A throwaway state directory for one test. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sts-compat-test-'));
}

/** A host `ToolExecution` as 0.2.1-rc.2 delivers it. */
function toolExecution(callId, name, toolArguments, cwd, sessionId) {
  return {
    callId,
    name,
    arguments: toolArguments,
    agent: { session: { id: sessionId, header: { cwd } } }
  };
}

/** The gate context the bridge hands `fromNativeEvent`. */
function gate(sessionId) {
  return { rootSessionId: sessionId, resolveRootSession: () => sessionId };
}

/** One verified user message, as the harness builds it. */
function userMessage(text) {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }]
  };
}

/** Arm a contract exactly the way the bridge does at `agent/pre-step`. */
function armContract(options, sessionId, text, cwd) {
  const payload = adapter.fromNativeEvent('agent/pre-step', {
    agent: { session: { id: sessionId, header: { cwd } } },
    messages: [userMessage(text)],
    turn: 1,
    step: 1
  });
  return adapter.handleDshHook('agent/pre-step', payload, options);
}

// ---------------------------------------------------------------------------
// `/sts` parsing
// ---------------------------------------------------------------------------

test('bare /sts reports status', () => {
  const parsed = parseStsInput('');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.directive, '$stop-that-shit status');
});

test('/sts status and /sts off map to the upstream runtime commands', () => {
  assert.equal(parseStsInput('status').directive, '$stop-that-shit status');
  assert.equal(parseStsInput('off').directive, '$stop-that-shit off');
});

test('/sts rebuilds a mode directive with options in upstream order', () => {
  const parsed = parseStsInput('review files=src/,test/ deps=allow hash=allow agents=2 -- fix the parser');
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.directive,
    '$stop-that-shit review files=src/|test/ deps=allow hash=allow agents=2 -- fix the parser'
  );
});

test('/sts accepts a level instead of a mode', () => {
  assert.equal(parseStsInput('lock').directive, '$stop-that-shit lock');
});

test('/sts accepts a pasted directive', () => {
  assert.equal(parseStsInput('$stop-that-shit monitor agents=1').directive, '$stop-that-shit monitor agents=1');
});

test('/sts rejects unknown modes, options, duplicates, and bad values', () => {
  for (const input of [
    'destroy',
    'review nope=1',
    'review files=src/ files=test/',
    'review agents=0',
    'review agents=two',
    'review deps=maybe',
    'review hash=',
    'review files='
  ]) {
    const parsed = parseStsInput(input);
    assert.equal(parsed.ok, false, `${input} must be rejected`);
    assert.equal(typeof parsed.text, 'string');
    assert.ok(parsed.text.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Post-execute result mapping
// ---------------------------------------------------------------------------

test('a denied pre-execute is proven to have never run at post-execute', () => {
  const options = { dataDir: tempDir() };
  const sessionId = 'session-arm';
  const cwd = process.cwd();
  const deniable = '$stop-that-shit change lock files=src/ -- tighten the parser';
  assert.equal(armContract(options, sessionId, deniable, cwd).kind, 'context');

  const hostExec = toolExecution('call-denied', 'write', { file_path: 'docs/readme.md', content: 'x' }, cwd, sessionId);
  const before = adapter.fromNativeEvent('tools/pre-execute', hostExec, gate(sessionId));
  const decision = adapter.handleDshHook('tools/pre-execute', before, options);
  assert.equal(decision && decision.kind, 'deny');

  // The harness still runs the post-execute waterfall for the synthesized
  // denial result, and that result carries no `kind` of its own.
  const hostResult = {
    isError: true,
    content: [{ type: 'text', text: `Error: ${decision.message}` }],
    error: { message: decision.message }
  };
  const after = adapter.fromNativeEvent(
    'tools/post-execute',
    hostExec,
    Object.assign({ result: hostResult }, gate(sessionId))
  );
  assert.equal(after.result.kind, 'deny');
  assert.equal(after.result.isError, true);
});

test('a pre-dispatch abort maps to cancel', () => {
  const options = { dataDir: tempDir() };
  const sessionId = 'session-abort';
  const cwd = process.cwd();
  const hostExec = toolExecution('call-abort', 'write', { file_path: 'src/a.js', content: 'x' }, cwd, sessionId);
  const after = adapter.fromNativeEvent(
    'tools/post-execute',
    hostExec,
    Object.assign({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
        error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }
      }
    }, gate(sessionId))
  );
  assert.equal(after.result.kind, 'cancel');
});

test('a mid-flight abort keeps the reservation', () => {
  const cwd = process.cwd();
  const hostExec = toolExecution('call-midabort', 'subagent', { prompt: 'work' }, cwd, 'session-mid');
  const after = adapter.fromNativeEvent(
    'tools/post-execute',
    hostExec,
    Object.assign({
      result: { isError: true, content: [], error: { message: 'aborted', info: { name: 'AbortError', code: 'ABORTED' } } }
    }, gate('session-mid'))
  );
  // No lifecycle fact: the delegated tool may already have started.
  assert.equal(after.result.kind, undefined);
});

test('an ordinary tool result carries no invented lifecycle fact', () => {
  const cwd = process.cwd();
  const hostExec = toolExecution('call-ok', 'write', { file_path: 'src/a.js', content: 'x' }, cwd, 'session-ok');
  const after = adapter.fromNativeEvent(
    'tools/post-execute',
    hostExec,
    Object.assign({ result: { isError: false, content: [{ type: 'text', text: 'ok' }] } }, gate('session-ok'))
  );
  assert.equal(after.result.kind, undefined);
  assert.deepEqual(after.exec, { callId: 'call-ok' });
});

// ---------------------------------------------------------------------------
// Guard default state
// ---------------------------------------------------------------------------

test('the guard is inert without a directive', () => {
  const options = { dataDir: tempDir() };
  const sessionId = 'session-inert';
  const cwd = process.cwd();
  const hostExec = toolExecution('call-inert', 'write', { file_path: 'outside.txt', content: 'x' }, cwd, sessionId);
  const payload = adapter.fromNativeEvent('tools/pre-execute', hostExec, gate(sessionId));
  assert.equal(adapter.handleDshHook('tools/pre-execute', payload, options), null);

  const after = adapter.fromNativeEvent(
    'tools/post-execute',
    hostExec,
    Object.assign({ result: { isError: false, content: [] } }, gate(sessionId))
  );
  assert.equal(adapter.handleDshHook('tools/post-execute', after, options), null);
});

// ---------------------------------------------------------------------------
// Subagent parent resolution
// ---------------------------------------------------------------------------

test('subagent parent resolution prefers the session store', () => {
  const childId = 'child-1';
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return { get: (id) => (id === childId ? { id, header: { parentSession: 'root-1' } } : undefined) };
    }
  };
  assert.equal(parentSessionOf(ctx, childId), 'root-1');
});

test('subagent parent resolution falls back to the live Agent', () => {
  const childId = 'child-2';
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => undefined };
      if (name === 'agents') {
        return {
          get: (id) => (id === childId ? { session: { id, header: { parentSession: 'root-2' } } } : undefined)
        };
      }
      return undefined;
    }
  };
  assert.equal(parentSessionOf(ctx, childId), 'root-2');
});

test('subagent parent resolution falls back to the emission initiator', () => {
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: () => undefined,
          currentInitiator: () => ({ session: { id: 'root-3', header: {} } })
        };
      }
      return undefined;
    }
  };
  assert.equal(parentSessionOf(ctx, 'child-3'), 'root-3');
});

test('subagent parent resolution refuses to guess', () => {
  assert.equal(parentSessionOf({ get: () => undefined }, 'child-4'), undefined);
  assert.equal(parentSessionOf({}, 'child-4'), undefined);
  assert.equal(parentSessionOf({ get: () => undefined }, ''), undefined);
});

// ---------------------------------------------------------------------------
// `/sts` registration
// ---------------------------------------------------------------------------

/** A Cordis-like context exposing only `inject`. */
function commandContext() {
  const registered = [];
  const unregistered = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['commands']);
      callback({ commands: { register: (definition) => { registered.push(definition); return () => unregistered.push(definition.name); } } });
      return { dispose() {} };
    }
  };
  return { ctx, registered, unregistered };
}

test('/sts registers one command and unregisters it on dispose', () => {
  const { ctx, registered, unregistered } = commandContext();
  const dispose = registerCommands(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'sts');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(typeof registered[0].description, 'string');
  assert.ok(registered[0].input.hint.includes('files='));
  dispose();
  assert.deepEqual(unregistered, ['sts']);
});

test('/sts injects the exact directive user message', async () => {
  const { ctx, registered } = commandContext();
  registerCommands(ctx);
  const delivered = [];
  const agent = { followup: (message) => delivered.push(message) };

  const result = await registered[0].handler({ agent, rawInput: 'review files=src/ deps=allow -- fix it' });
  assert.equal(result.kind, 'success');
  assert.equal(delivered.length, 1);
  const message = delivered[0];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, '$stop-that-shit review files=src/ deps=allow -- fix it');
  assert.equal(typeof message.id, 'string');
  assert.ok(Object.isFrozen(message));
});

test('/sts reports a usage error without injecting anything', async () => {
  const { ctx, registered } = commandContext();
  registerCommands(ctx);
  const delivered = [];
  const agent = { followup: (message) => delivered.push(message) };
  const result = await registered[0].handler({ agent, rawInput: 'destroy everything' });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('Unknown mode'));
  assert.equal(delivered.length, 0);
});