'use strict';

/**
 * DSH compatibility layer for the Stop That Shit bridge.
 *
 * `src/adapters/dsh-hooks.cjs` is vendored verbatim from upstream and stays
 * untouched. This file maps the payload shapes DeepSeek Harness 0.2.1-rc.2
 * actually delivers onto the shapes that adapter expects, and adds the `/sts`
 * slash command. Everything here is additive: with no mapping active the
 * vendor adapter behaves exactly as it shipped.
 *
 * Mappings in force (host fact -> adapter shape):
 *
 * | Host fact (0.2.1-rc.2)                                      | Adapter expects                          | Mapping here                                   |
 * | ----------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
 * | `ToolExecutionResult` has no `kind`                          | `result.kind === 'deny'\|'cancel'`       | stamp `kind` on the post-execute result only   |
 * | a denied pre-execute still reaches `tools/post-execute`      | proof the call never ran                  | correlate by `exec.callId`, stamp `'deny'`     |
 * | `result.error.info.code === 'ABORTED_BEFORE_DISPATCH'`       | proof the call never ran                  | stamp `'cancel'`                               |
 * | `SubagentRunInfo` carries no parent session id               | parent id for `subagent.start/stop`      | resolve the child's header, then the live Agent|
 * | `@deepseek-ai/dsh-llm` may not resolve from a linked package | `createUserMessage()` helper             | dynamic import, identical local factory        |
 *
 * Nothing else is remapped: `agent/pre-step`, `tools/pre-execute`,
 * `session/created|disposed` and `subagent/start|end` already match the
 * adapter field for field (verified against the 0.2.1-rc.2 API catalog).
 */

const { randomUUID } = require('node:crypto');

const vendor = require('../src/adapters/dsh-hooks.cjs');

// ---------------------------------------------------------------------------
// Tool-result lifecycle facts
// ---------------------------------------------------------------------------

/**
 * Canonical DSH abort codes. Harness result factories put these on
 * `result.error.info.code`; the plain `result.error.code` form is accepted as
 * a fallback for hand-built results.
 */
const ABORTED = 'ABORTED';
const ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';

/** How long a pre-execute denial stays available for its post-execute pass. */
const DENIAL_TTL_MS = 10 * 60 * 1000;

/** Upper bound on the denial ledger so a lost post-execute cannot grow it. */
const DENIAL_LEDGER_LIMIT = 512;

/** Tool call ids this bridge denied in `tools/pre-execute`, with timestamps. */
const deniedCalls = new Map();

/** Drop ledger entries that can no longer be matched. */
function pruneDenials(now) {
  for (const [callId, recordedAt] of deniedCalls) {
    if (now - recordedAt <= DENIAL_TTL_MS) break;
    deniedCalls.delete(callId);
  }
  while (deniedCalls.size > DENIAL_LEDGER_LIMIT) {
    const oldest = deniedCalls.keys().next();
    if (oldest.done) break;
    deniedCalls.delete(oldest.value);
  }
}

/** Read a tool call id from a host `ToolExecution` or a normalized payload. */
function callIdOf(exec) {
  if (!exec || typeof exec !== 'object') return undefined;
  const raw = exec.callId;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id.length > 0) return raw.id;
  return undefined;
}

/** Remember that this bridge denied one pre-execute call. */
function rememberDenial(callId) {
  if (callId === undefined) return;
  const now = Date.now();
  deniedCalls.delete(callId);
  deniedCalls.set(callId, now);
  pruneDenials(now);
}

/** Consume a remembered denial; a call only ever settles once. */
function takeDenial(callId) {
  if (callId === undefined || !deniedCalls.has(callId)) return false;
  deniedCalls.delete(callId);
  return true;
}

/** Read a factory-style abort code from a host tool result. */
function abortCode(result) {
  if (!result || typeof result !== 'object') return undefined;
  const error = result.error;
  if (!error || typeof error !== 'object') return undefined;
  const info = error.info;
  if (info && typeof info === 'object' && typeof info.code === 'string') return info.code;
  if (typeof error.code === 'string') return error.code;
  return undefined;
}

/**
 * Lifecycle fact for one settled tool call, or `undefined` when the call
 * carries no such fact.
 *
 * Only the two provable "never ran" cases are mapped. A mid-flight `ABORTED`
 * stays unmapped on purpose: the delegated tool may already have started, so
 * the reservation must be kept for `subagent/end` to release.
 *
 * @param exec - normalized post-execute payload (`{ callId }`) or host exec.
 * @param result - the host `ToolExecutionResult`.
 */
function toolLifecycleKind(exec, result) {
  if (abortCode(result) === ABORTED_BEFORE_DISPATCH) return 'cancel';
  if (takeDenial(callIdOf(exec))) return 'deny';
  return undefined;
}

// ---------------------------------------------------------------------------
// Parent session resolution
// ---------------------------------------------------------------------------

/** Read a service by name without tripping Cordis' inject guard. */
function serviceOf(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** The header parent of one session, from the session store. */
function parentFromSessions(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions');
  if (!sessions || typeof sessions.get !== 'function') return undefined;
  let session;
  try {
    session = sessions.get(sessionId);
  } catch {
    return undefined;
  }
  const header = session && session.header;
  return header && header.parentSession ? String(header.parentSession) : undefined;
}

/** The header parent of one session, from the live Agent registry. */
function parentFromAgents(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents');
  if (!agents || typeof agents.get !== 'function') return undefined;
  let agent;
  try {
    agent = agents.get(sessionId);
  } catch {
    return undefined;
  }
  const header = agent && agent.session && agent.session.header;
  return header && header.parentSession ? String(header.parentSession) : undefined;
}

/**
 * Parent session of a subagent run.
 *
 * `SubagentRunInfo` in 0.2.1-rc.2 is `{ runId, provider, id, local }` — the
 * child id only, no parent. The bridge resolves the parent to key the
 * contract, so the child's own header is the primary source; a session store
 * that has not published the child yet falls back to the live Agent, and
 * finally to the initiating Agent of the subagent/start emission.
 *
 * @param ctx - plugin context.
 * @param childId - the child session id from the subagent event.
 * @returns the parent session id, or `undefined` when it cannot be proven.
 */
function parentSessionOf(ctx, childId) {
  if (typeof childId !== 'string' || childId.length === 0) return undefined;
  const fromSessions = parentFromSessions(ctx, childId);
  if (fromSessions !== undefined) return fromSessions;
  const fromAgents = parentFromAgents(ctx, childId);
  if (fromAgents !== undefined) return fromAgents;
  const agents = serviceOf(ctx, 'agents');
  if (!agents || typeof agents.currentInitiator !== 'function') return undefined;
  let initiator;
  try {
    initiator = agents.currentInitiator();
  } catch {
    return undefined;
  }
  const id = initiator && initiator.session && initiator.session.id;
  if (typeof id !== 'string' || id.length === 0 || id === childId) return undefined;
  return id;
}

// ---------------------------------------------------------------------------
// Adapter wrapper
// ---------------------------------------------------------------------------

/**
 * `fromNativeEvent` with the post-execute result fact mapping applied.
 *
 * Everything else is delegated to the vendor adapter unchanged.
 */
function compatFromNativeEvent(hookPoint, native, context) {
  const payload = vendor.fromNativeEvent(hookPoint, native, context || {});
  if (!payload || hookPoint !== 'tools/post-execute') return payload;
  const result = payload.result;
  if (!result || typeof result !== 'object') return payload;
  // A host that already reports a lifecycle kind wins over any mapping.
  if (typeof result.kind === 'string') return payload;
  const kind = toolLifecycleKind(payload.exec, result);
  if (kind === undefined) return payload;
  return Object.assign({}, payload, { result: Object.assign({}, result, { kind }) });
}

/**
 * `handleDshHook` that records every denial it issues, so the matching
 * post-execute pass can prove the call never ran.
 */
function compatHandleDshHook(hookPoint, payload, options) {
  const result = vendor.handleDshHook(hookPoint, payload, options);
  if (hookPoint === 'tools/pre-execute' && result && result.kind === 'deny') {
    rememberDenial(callIdOf(payload && payload.exec));
  }
  return result;
}

/** The vendor adapter with the payload mappings layered on top. */
const adapter = Object.assign({}, vendor, {
  fromNativeEvent: compatFromNativeEvent,
  handleDshHook: compatHandleDshHook
});

// ---------------------------------------------------------------------------
// `/sts` command
// ---------------------------------------------------------------------------

/** Slash command name (without the leading slash). */
const COMMAND_NAME = 'sts';

/** Stable definition id, mirroring the `@scope/package` brand other plugins use. */
const COMMAND_DEFINITION_ID = 'dsh-stop-that-shit/sts';

/** The directive marker upstream's contract parser arms on. */
const DIRECTIVE = '$stop-that-shit';

/** Upstream task modes, plus the levels that may open a directive. */
const MODES = Object.freeze(['answer', 'review', 'change', 'monitor']);
const LEVELS = Object.freeze(['watch', 'guard', 'lock']);
const POLICIES = Object.freeze(['deny', 'ask', 'allow']);
const OPTION_KEYS = Object.freeze(['files', 'deps', 'hash', 'agents']);

const INPUT_HINT = 'status | off | review|answer|monitor|change|watch '
  + '[files=a,b] [deps=deny|ask|allow] [hash=deny|ask|allow] [agents=N] [-- task]';

/** Usage block returned for an unparseable invocation. */
const USAGE = [
  'Stop That Shit usage:',
  '  /sts status                report the session contract and host effect',
  '  /sts off                   turn the guard off for this session',
  '  /sts <mode> [options] [-- task]',
  `    modes: ${MODES.join(' | ')}`,
  `    levels: ${LEVELS.join(' | ')}`,
  '    options: files=a,b  deps=deny|ask|allow  hash=deny|ask|allow  agents=N',
  'Options go before `--`; everything after `--` is task text.',
  'The same text works as a plain message: `$stop-that-shit review -- task`.'
].join('\n');

/** Split a `files=` value into the upstream `a|b` form. */
function normalizeFiles(value) {
  const entries = value
    .split(/[|,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  return entries.join('|');
}

/** Validate one `key=value` directive option. */
function parseOption(token) {
  const separator = token.indexOf('=');
  if (separator <= 0) {
    return { ok: false, text: `Unknown argument "${token}". Arguments look like files=a,b or deps=ask.\n\n${USAGE}` };
  }
  const key = token.slice(0, separator).toLowerCase();
  const rawValue = token.slice(separator + 1).trim();
  if (!OPTION_KEYS.includes(key)) {
    return { ok: false, text: `Unknown argument "${key}". Supported: ${OPTION_KEYS.join(', ')}.\n\n${USAGE}` };
  }
  if (key === 'files') {
    const files = normalizeFiles(rawValue);
    if (files === undefined) return { ok: false, text: `"files=" needs at least one path, for example files=src/,test/.\n\n${USAGE}` };
    return { ok: true, key, value: files };
  }
  if (key === 'agents') {
    if (!/^\d+$/.test(rawValue) || Number(rawValue) < 1) {
      return { ok: false, text: `"agents=" must be a positive whole number, for example agents=2.\n\n${USAGE}` };
    }
    return { ok: true, key, value: String(Number(rawValue)) };
  }
  if (!POLICIES.includes(rawValue)) {
    return { ok: false, text: `"${key}=" must be one of ${POLICIES.join(', ')}.\n\n${USAGE}` };
  }
  return { ok: true, key, value: rawValue };
}

/**
 * Translate `/sts ...` input into the exact user message upstream's contract
 * parser expects.
 *
 * @param rawInput - the text after `/sts`.
 * @returns `{ ok: true, directive, report }` or `{ ok: false, text }`.
 */
function parseStsInput(rawInput) {
  const trimmed = String(rawInput === undefined || rawInput === null ? '' : rawInput).trim();
  if (trimmed.length === 0) {
    return { ok: true, directive: `${DIRECTIVE} status`, report: 'Stop That Shit: requested the session status.' };
  }

  const separator = trimmed.indexOf('--');
  const head = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const task = separator === -1 ? '' : trimmed.slice(separator + 2).trim();
  const tokens = head.split(/\s+/).filter((token) => token.length > 0);

  // Accept a pasted directive verbatim: `/sts $stop-that-shit review`.
  if (tokens.length > 0 && /^\$(?:stop-that-shit:)?stop-that-shit$/i.test(tokens[0])) tokens.shift();
  if (tokens.length === 0) return { ok: false, text: `Missing mode.\n\n${USAGE}` };

  const first = tokens[0].toLowerCase();
  if (tokens.length === 1 && first === 'status') {
    return { ok: true, directive: `${DIRECTIVE} status`, report: 'Stop That Shit: requested the session status.' };
  }
  if (tokens.length === 1 && first === 'off') {
    return { ok: true, directive: `${DIRECTIVE} off`, report: 'Stop That Shit: turned the guard off for this session.' };
  }
  if (!MODES.includes(first) && !LEVELS.includes(first)) {
    return {
      ok: false,
      text: `Unknown mode "${tokens[0]}". Use ${MODES.concat(LEVELS).concat(['status', 'off']).join(', ')}.\n\n${USAGE}`
    };
  }

  const options = [];
  const seen = new Set();
  for (const token of tokens.slice(1)) {
    const option = parseOption(token);
    if (!option.ok) return option;
    if (seen.has(option.key)) {
      return { ok: false, text: `Argument "${option.key}" was given twice.\n\n${USAGE}` };
    }
    seen.add(option.key);
    options.push(`${option.key}=${option.value}`);
  }

  // Upstream parses the head up to the first `--`, so keep the same order.
  const directive = [`${DIRECTIVE} ${first}`, ...options, task.length > 0 ? `-- ${task}` : '']
    .filter((part) => part.length > 0)
    .join(' ');
  const report = `Stop That Shit: sent "${directive}".`;
  return { ok: true, directive, report };
}

/** Deep-freeze a message the way `@deepseek-ai/dsh-llm` does. */
function localCreateUserMessage(input) {
  const content = Array.isArray(input.content)
    ? Object.freeze(input.content.map((block) => (block && typeof block === 'object' ? Object.freeze({ ...block }) : block)))
    : input.content;
  return Object.freeze({ ...input, content, role: 'user', id: randomUUID() });
}

/** Cached resolver for the harness message factory. */
let messageFactoryPromise;

/**
 * `createUserMessage` from `@deepseek-ai/dsh-llm`, or a byte-compatible local
 * factory when a linked plugin cannot resolve the harness packages.
 *
 * Local plugins are installed with `link:`, so their real path is outside the
 * profile's `node_modules` and the harness packages are often unreachable.
 * The fallback produces the same fields (`role`, `id`, deep-frozen) that
 * `createUserMessage` produces, which is all the message contract requires.
 */
function loadCreateUserMessage() {
  if (messageFactoryPromise === undefined) {
    messageFactoryPromise = (async () => {
      try {
        const llm = await import('@deepseek-ai/dsh-llm');
        if (llm && typeof llm.createUserMessage === 'function') return llm.createUserMessage;
      } catch {
        // Expected for a `link:`-installed package; the fallback is equivalent.
      }
      return localCreateUserMessage;
    })();
  }
  return messageFactoryPromise;
}

/**
 * Handler for `/sts`.
 *
 * The command never acts on the guard directly: it injects the same
 * `$stop-that-shit ...` user message a human would type, so the guard sees one
 * code path and the transcript shows exactly what was asked.
 */
async function handleStsCommand(invocation) {
  const parsed = parseStsInput(invocation && invocation.rawInput);
  if (!parsed.ok) return { kind: 'error', text: parsed.text };
  const agent = invocation && invocation.agent;
  if (!agent || typeof agent.followup !== 'function') {
    return { kind: 'error', text: 'Stop That Shit: /sts needs a live Agent turn; none is attached to this invocation.' };
  }
  const createUserMessage = await loadCreateUserMessage();
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: parsed.directive }],
    source: { kind: 'user' }
  }));
  return { kind: 'success', text: parsed.report };
}

/**
 * Register `/sts` on the `commands` service.
 *
 * The registration lives on the command service's own fiber, so this returns
 * the disposer that unregisters it and the caller (the bridge) hands that
 * disposer to `ctx.effect()` for exact teardown.
 *
 * @param ctx - plugin context.
 * @returns a disposer that unregisters the command.
 */
function registerCommands(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return () => {};
  // Warm the message factory so the first `/sts` never waits on the import.
  void loadCreateUserMessage();
  const disposers = [];
  let disposed = false;
  ctx.inject(['commands'], (injected) => {
    const commands = injected && injected.commands;
    if (!commands || typeof commands.register !== 'function') return;
    const dispose = commands.register({
      definitionId: COMMAND_DEFINITION_ID,
      name: COMMAND_NAME,
      description: 'Stop That Shit: show the guard status, arm a mode, or turn it off',
      input: { hint: INPUT_HINT },
      recordInput: true,
      handler: handleStsCommand
    });
    if (disposed) {
      if (typeof dispose === 'function') dispose();
      return;
    }
    if (typeof dispose === 'function') disposers.push(dispose);
  });
  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // The command service may already be gone; nothing left to undo.
      }
    }
  };
}

module.exports = {
  adapter,
  parseStsInput,
  parentSessionOf,
  registerCommands
};