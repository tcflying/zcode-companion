#!/usr/bin/env node
/**
 * verify-runtime.mjs — I02 entry point for runtime discovery and the
 * zero-send capability probe.
 *
 * WHAT IT WILL DO
 *   evidence    print the capability matrix and the billing evidence map.
 *               Spawns nothing, opens nothing, reads nothing from disk.
 *   discovery   observe the three official runtime layers with read-only,
 *               bounded commands only (`<cli> --version`, `<cli> --help`,
 *               streamed SHA-256 of the declared files).
 *   contract    run the I02 contract test through Node's own test runner.
 *   probe       the REAL zero-send probe. REFUSED unless the operator passes
 *               --i02-real-probe-ack, which is a human decision, not a flag
 *               this task sets for itself. Passively observes only. P4's active
 *               readback needs a SECOND, separate flag
 *               (--p4-active-readback-ack) because it writes.
 *
 * WHAT IT WILL NEVER DO
 *   Start the official app-server without an acknowledgement. Send a model
 *   request. Read or decrypt a credential. Read or write a production database.
 *   Modify the official installation. Commit or push.
 *
 *   Two honest exceptions to "read-only", both counted in the ledger and neither
 *   a model dispatch: the probe answers a reverse request from the runtime with
 *   a JSON-RPC -32601 error (ledger.refusalFrames), and P4 writes exactly one
 *   control-plane request (ledger.controlFrames). Neither can reach a provider:
 *   the write allowlist holds one method whose official handler is a compiled-in
 *   literal. I02-F4 removed the second one it used to hold: the
 *   startup/storagePathReady reply, which belonged to a different mode of the
 *   official CLI and is unreachable from this file.
 *
 * Exit codes:
 *   0  OK
 *   1  the command ran and failed (including a P4 readback that did not match)
 *   2  USAGE / UNKNOWN_COMMAND / UNKNOWN_OPTION
 *   3  REFUSED — a safety precondition was not met, nothing was started
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_SRC = join(PROJECT_ROOT, 'packages', 'runtime', 'src');
const STAGE_GATE = join(PROJECT_ROOT, 'scripts', 'stage-gate.mjs');

const USAGE = `USAGE: node scripts/verify-runtime.mjs <command> [options]

Commands:
  evidence                       capability matrix + billing evidence map (spawns nothing)
  discovery [options]            read-only observation of the three runtime layers
  probe-plan                     print the zero-send real-probe command list; STARTS NOTHING
  contract                       run the I02 contract suite via the project gate (vitest)
  probe [options]                REAL zero-send probe; refused without an explicit ack

discovery options:
  --hash <none|cli|asar|all>     which declared files to hash (default: none)
  --cli-version                  run \`node <cli> --version\`   (read-only)
  --cli-help                     run \`node <cli> --help\`      (read-only)
  --cli <path>                   override the official CLI bundle path
  --asar <path>                  override the official desktop ASAR path

probe options:
  --i02-real-probe-ack           REQUIRED. A human must pass this.
  --p4-active-readback-ack       REQUIRED IN ADDITION, and only for P4. The second,
                                 independent acknowledgement that turns this from a
                                 passive observation into a run that WRITES one frame.
  --cli <path>                   official CLI bundle path (defaults to C:/ZCode/resources/glm/zcode.cjs)
  --timeout-ms <n>               per-request bound (default 5000)
`;

/**
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const COMMANDS = new Set(['evidence', 'discovery', 'contract', 'probe', 'probe-plan', 'help']);
const HASH_TARGETS = new Set(['none', 'cli', 'asar', 'all']);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ command: string | undefined, flags: Set<string>, values: Map<string, string> }} */
  const parsed = { command: undefined, flags: new Set(), values: new Map() };
  const valueOptions = new Set(['--hash', '--cli', '--asar', '--timeout-ms']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') { parsed.flags.add('--help'); continue; }
    if (arg.startsWith('--')) {
      if (valueOptions.has(arg)) {
        const value = argv[i + 1];
        if (value === undefined) fail(2, `MISSING_VALUE: ${arg}\n${USAGE}`);
        parsed.values.set(arg, value);
        i++;
        continue;
      }
      if (!KNOWN_FLAGS.has(arg)) fail(2, `UNKNOWN_OPTION: ${arg}\n${USAGE}`);
      parsed.flags.add(arg);
      continue;
    }
    if (parsed.command === undefined) parsed.command = arg;
    else fail(2, `UNEXPECTED_ARGUMENT: ${arg}\n${USAGE}`);
  }
  return parsed;
}

const KNOWN_FLAGS = new Set([
  '--cli-version',
  '--cli-help',
  '--i02-real-probe-ack',
  '--p4-active-readback-ack',
  '--help',
  '--json'
]);

const { command, flags, values } = parseArgs(process.argv.slice(2));
if (flags.has('--help') || command === undefined || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(command === 'help' || flags.has('--help') ? 0 : 2);
}
if (!COMMANDS.has(command)) fail(2, `UNKNOWN_COMMAND: ${command}\n${USAGE}`);

/**
 * Loads the runtime modules. The capability module re-exports the discovery
 * surface, so one import is enough.
 *
 * CORRECTED ON REVIEW: the frozen half-product did
 * `import(join(RUNTIME_SRC, 'capability-probe.ts'))`. On Windows that yields
 * `G:\...\capability-probe.ts`, which the ESM loader rejects with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'g:'"). The script had
 * never been executed, so the defect was invisible. An absolute path must be
 * handed to `import()` as a file:// URL.
 * @returns {Promise<any>}
 */
async function loadRuntime() {
  const specifier = pathToFileURL(join(RUNTIME_SRC, 'capability-probe.ts')).href;
  return import(specifier);
}

/** @param {unknown} value */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Prints a report with redaction applied.
 *
 * CORRECTED ON REVIEW: the frozen half-product wrote `printJson(redact(report))`,
 * which emits `{value: <report>, redactedKeys: [...]}`. A consumer of this
 * script had to know that the report was buried under `value`. stdout is now the
 * report itself, and the list of redacted KEY NAMES (never values) goes to
 * stderr so the machine-readable stream stays clean.
 * @param {any} runtime
 * @param {unknown} report
 */
function printRedacted(runtime, report) {
  const out = runtime.redact(report);
  printJson(out.value);
  if (out.redactedKeys.length > 0) {
    process.stderr.write(`I02: redacted key NAMES only (values never printed): ${out.redactedKeys.join(', ')}\n`);
  }
}

/**
 * F11 (ZC-03). The ONE answer P4 accepts, and nothing else.
 *
 * This is not a new contract. `probe-plan` has published it all along — see the
 * `P4-capabilities-readback` step's own `expect`: the official readback is
 * `{id, result}` with NO `jsonrpc` member (E-BUNDLE-021/024: the response
 * schema is `.strict()` and declares no other member), and `result` is the
 * compiled-in literal `{independentPlanState: true}` (E-BUNDLE-003). What was
 * missing is the CODE that enforces it. Until now the verdict was the
 * transport's: a frame that arrived, was well enough formed to parse, and
 * carried the id we sent. That is a true statement about bytes and a false
 * statement about the capability, which is the whole of F11.
 */
const P4_ACCEPTED_TOP_LEVEL_KEYS = Object.freeze(['id', 'result']);

/**
 * F11. The shape half of the acceptance: the response frame carries ONLY `id`
 * and `result`.
 *
 * Compared in sorted order because JSON object key order carries no protocol
 * meaning (the same is said where the outbound frame's key order is explained).
 * Kept as its own named predicate so it can be removed, and only it, and the
 * removal can be shown to change an outcome.
 *
 * @param {readonly string[]} keys sorted top-level key names
 * @returns {boolean}
 */
function hasOfficialP4Shape(keys) {
  return keys.length === P4_ACCEPTED_TOP_LEVEL_KEYS.length
    && keys.every((key, index) => key === P4_ACCEPTED_TOP_LEVEL_KEYS[index]);
}

/**
 * F11. The value half of the acceptance: `result` is EXACTLY
 * `{independentPlanState: true}` — one key, and that value.
 *
 * A capability that came back `false` is not a smaller success; it is the
 * absence of the one thing P4 exists to observe.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAcceptedP4Result(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value));
  if (keys.length !== 1 || keys[0] !== 'independentPlanState') return false;
  return /** @type {Record<string, unknown>} */ (value)['independentPlanState'] === true;
}

/**
 * F11. The semantic verdict on a frame that ALREADY correlated with our id.
 *
 * Why this is not redundant with the correlation check: the client classifies a
 * frame that carries an id and an `error` member as `error_response`, and its
 * waiter selector accepts `error_response` exactly like `response` when the id
 * matches. A correlated ERROR therefore reaches the caller as a transport
 * success, which is why an error used to be reported as an acceptance.
 *
 * Only the CORRELATED frame is ever judged here. An error frame whose id is NOT
 * the one we sent never arrives at this function: it neither satisfies the
 * waiter nor ends the wait (I02-F3-3), so the relevance protection is untouched
 * — it still ends up in `frameLog`, and a later correct response still wins.
 *
 * @param {any} frame the correlated frame, verbatim
 * @param {any} shape its `describeFrameShape` summary, or null when there was none
 * @param {any} runtime the loaded runtime module, for the OFFICIAL classifier
 * @returns {{accepted: boolean, frameKind: string, topLevelKeys: readonly string[], reasons: readonly string[]}}
 */
function assessP4Semantics(frame, shape, runtime) {
  const frameKind = runtime.classifyInboundFrame(frame);
  const topLevelKeys = Array.isArray(shape?.topLevelKeys) ? [...shape.topLevelKeys] : Object.keys(frame);
  const reasons = [];
  if (frameKind !== 'response') {
    reasons.push(`the correlated frame is an official "${frameKind}" frame, not a result response`);
  }
  if (!hasOfficialP4Shape([...topLevelKeys].sort())) {
    reasons.push(
      `top-level keys are ${JSON.stringify(topLevelKeys)}, expected exactly ["id","result"] — the official response schema is .strict() and declares no other member (E-BUNDLE-021/024)`
    );
  }
  if (!isAcceptedP4Result(frame['result'])) {
    reasons.push(`result is ${JSON.stringify(frame['result'] ?? null)}, expected exactly {"independentPlanState":true} (E-BUNDLE-003)`);
  }
  return { accepted: reasons.length === 0, frameKind, topLevelKeys, reasons };
}

/** @param {any} runtime */
async function commandEvidence(runtime) {
  const report = runtime.buildProbeReport(null);
  printRedacted(runtime, report);
  const counts = report.counts;
  process.stderr.write(
    `I02 evidence: ${counts.total} capabilities — ${counts.mechanismVerified} mechanism_verified, `
    + `${counts.unknown} unknown, ${counts.blocked} blocked, ${counts.behaviourVerified} behaviour_verified.\n`
    + 'I02 executed NO probe against the official runtime, so runtimeReady is false and no capability may be '
    + 'reported as behaviour-verified. Fixture transport results never upgrade a capability.\n'
  );
  return 0;
}

/** @param {any} runtime */
async function commandDiscovery(runtime) {
  const hash = values.get('--hash') ?? 'none';
  if (!HASH_TARGETS.has(hash)) fail(2, `UNKNOWN_HASH_TARGET: ${hash} (expected ${[...HASH_TARGETS].join('|')})`);
  const report = await runtime.discoverRuntime({
    hash,
    readCliVersion: flags.has('--cli-version'),
    readCliHelp: flags.has('--cli-help'),
    ...(values.has('--cli') ? { cliBundlePath: values.get('--cli') } : {}),
    ...(values.has('--asar') ? { desktopAsarPath: values.get('--asar') } : {})
  });
  printRedacted(runtime, report);
  if (report.summary.anyLayerBlocked) {
    // m-5: this used to fire on every run, because `live_host` is
    // unknown_by_design by construction and was counted as unverified. Now it
    // names the layers that were genuinely expected to verify and did not.
    process.stderr.write(
      `I02 discovery: these layers were expected to verify and did not: ${report.summary.unverifiedLayers.join(', ')}. `
      + 'See identityConfidence and identityReasons on each.\n'
    );
  }
  process.stderr.write(
    'I02 discovery observed FILES only. The running official host version stays unknown_by_design and is '
    + 'never substituted by an installed version. That layer is reported separately and is NOT counted as blocked.\n'
  );
  return 0;
}

async function commandContract() {
  // CORRECTED ON REVIEW: the frozen half-product ran this suite with
  // `node --test`. The suite now lives in tests/contract/ and is a vitest
  // suite, because that is the only runner `npm test` actually collects. It is
  // therefore run through the project-owned gate rather than a second, private
  // runner that would let the suite silently stop being executed at all.
  const child = spawn(process.execPath, [STAGE_GATE, 'test:contract'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: false
  });
  return await new Promise((resolvePromise) => {
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/**
 * Prints the exact zero-send real-probe plan for the coordinator. Starts nothing,
 * sends nothing, reads nothing — it is a document, not an action.
 * @param {any} runtime
 */
async function commandProbePlan(runtime) {
  const cli = values.get('--cli') ?? 'C:/ZCode/resources/glm/zcode.cjs';
  const steps = [
    {
      id: 'P1-identity',
      // REV4 m-6: this said `--hash cli` while the report said `--hash all`.
      // They are not equivalent — `all` additionally hashes the desktop ASAR —
      // and `--hash all` is the stricter one and the one the review actually ran
      // to a full pass. The looser form has been retired, not documented.
      command: 'node scripts/verify-runtime.mjs discovery --hash all --cli-version --cli-help',
      spawnsOfficialRuntime: false,
      writesAFrame: false,
      expect: 'exit 0; layers[].identityConfidence === "content_verified" for cli_bundle and desktop_asar; cliVersion.parsedVersion === "0.16.9"; cliHelp.helpTextSha256 === "792f3f9bce61a346181887daa1d8eedf01b7ba47c367f9f44a0e6b73038cf6db"',
      pass: 'observed sha256 equals the I00 baseline and the parsed version equals the pinned version',
      alsoExpect: 'summary.anyLayerBlocked === false and summary.unverifiedLayers === [] (live_host is unknown_by_design and is NOT counted as blocked — see the m-5 fix)'
    },
    {
      id: 'P2-mandatory-models-endpoint',
      command: `node scripts/verify-runtime.mjs probe --i02-real-probe-ack --cli "${cli}" --timeout-ms 5000`,
      spawnsOfficialRuntime: true,
      writesAFrame: false,
      // I-4. The old wording here was "the product writes no frame", which is
      // false the moment the runtime asks for anything: the client answers a
      // reverse request with a JSON-RPC -32601 error, and that IS a write. The
      // honest statement separates the two counters.
      expect: 'exit 0; ledger.modelDispatch === 0; ledger.modelDispatchAttempts === 0; ledger.controlFrames === 0 (this command composes no request of its own); ledger.refusalFrames >= 0 — a non-zero refusalFrames is EXPECTED whenever the runtime asked for anything, and is recorded rather than hidden',
      pass: 'modelDispatch is 0 AND the child was reclaimed via our own handle (stage is stdin-eof or sigterm, never a name/port kill)',
      counterSemantics: 'controlFrames counts REQUEST frames this product originated and EXCLUDES the -32601 refusal frames. refusalFrames counts those refusals. A refusal is not a model dispatch and never reaches the allowlist.'
    },
    {
      id: 'P3-handshake-direction',
      command: `node scripts/verify-runtime.mjs probe --i02-real-probe-ack --cli "${cli}" --timeout-ms 15000`,
      spawnsOfficialRuntime: true,
      writesAFrame: false,
      // I-2. The old text asked for a structural check against E-BUNDLE-014/016
      // while the tool printed only `Object.keys(frame)`, so the check could not
      // be performed at all. `observation.frameShape` now carries the method
      // name value and, per field, only name / JSON type / string length in code
      // units and bytes / array length / field count / official-enum membership
      // / official-literal match. No value is printed.
      expect: 'observation.frameShape.methodName is one of "startup/storagePath", "startup/storagePrepared", "startup/storageState"; and for the variant observed: storagePath -> paramsShape has exactly one field named "path" of type "string" with 1 <= stringLength <= 32768; storagePrepared -> paramsShape is []; storageState -> field "schemaVersion" with matchesOfficialLiteral === true, field "databaseKind" with officialEnum === "databaseKind" and isOfficialEnumMember === true, and field "phase" with officialEnum === "phase" and isOfficialEnumMember === true (the official phase enum has SIX members, not seven: checking, waiting_for_lock, migrating, committing, ready, failed)',
      // I02-F4: the downgrade target moved with the row. The row is now
      // behavior_verified on E-PROBE-R3-P4, so a shape that stops matching
      // E-BUNDLE-014/016 takes it back DOWN to mechanism_verified — "named by a
      // source" — rather than all the way to unknown, which would be a claim
      // that the sequence itself was never seen.
      pass: 'the observed shape validates against E-BUNDLE-014/016; a mismatch downgrades zero_send_startup_handshake from behavior_verified back to mechanism_verified',
      notPrinted: 'the path VALUE, attemptId, databaseId and the JSON-RPC id value are never printed — only their types and lengths. If a future criterion needs a value, take it from a raw capture offline, not from this output.'
    },
    {
      id: 'P4-capabilities-readback',
      // I-1. This step used to be written as "after P3 succeeds, send
      // runtime/capabilities only" appended to the P3 command, which is not a
      // command anybody can run and which the old code could not do anyway. It
      // is now a real, separate invocation behind a SECOND acknowledgement, and
      // it is implemented.
      command: `node scripts/verify-runtime.mjs probe --i02-real-probe-ack --p4-active-readback-ack --cli "${cli}" --timeout-ms 10000`,
      spawnsOfficialRuntime: true,
      writesAFrame: true,
      acknowledgement: 'TWO flags are required. --i02-real-probe-ack authorises a passive observation; --p4-active-readback-ack is a separate, additional human decision that authorises writing one frame to a live official process. Neither implies the other.',
      expect: 'stderr prints the exact outbound line BEFORE the send; then p4.outcome === "ok", p4.result equals {"independentPlanState":true} per E-BUNDLE-003, p4.responseIdMatchedRequest === true, p4.resultShape.topLevelKeys is exactly ["id","result"] (the official response has NO jsonrpc member — E-BUNDLE-021/024), and p4.controlFrames === 1 (I02-F4: the startup reply was removed, so the readback is the only frame this product originates)',
      pass: 'exact field read back AND the response carries the id the client assigned; on mismatch, report drift rather than substituting the installed version',
      failureExitCode: 1,
      sendsOnly: 'runtime/capabilities — the single entry on the write allowlist, whose official handler is a compiled-in literal. I02-F3-2 CORRECTED THE FRAME SHAPE: the outbound request is {"id":"<n>","method":...,"params":{}} with NO `jsonrpc` member, because the official request schema `qir=m.object({id:yYe,method:Dn,params:m.unknown().optional(),trace:$Ht.optional()}).strict()` does not declare one and is strict (E-BUNDLE-021). The refusal frame written back down the reverse channel was corrected the same way. I02-F4 REMOVED `startup/storagePathReady` from the allowlist and from this path entirely (see startupReplyRemoved). Zero model frames are sent.',
      round3Diagnosis: 'I02-F3-2 explains the round-2 failure completely. The server DID answer, with `sendError("invalid-message",-32600,"Invalid ZCode Protocol message",{issues:o.error.issues})` — a frame whose `id` is the 15-character reason LITERAL "invalid-message" and whose message is the 30-character literal "Invalid ZCode Protocol message". Both literals occur EXACTLY ONCE in the whole 14.8 MB bundle, and the capture recorded idStringLength 15 / message length 30 / topLevelKeys ["error","id"] with data.issues of length 1 — a full match (E-BUNDLE-022). The coordinator\'s 15-char hypothesis is FALSIFIED: it is neither a reply to our storagePathReady notification (E-BUNDLE-023 — the server IGNORES id-less notifications by design) nor a missing version negotiation (E-BUNDLE-027 — the complete 3254-character official method map contains no initialize and no version method of any kind). It is a whole-message schema rejection whose id is a fixed diagnostic token, so id-correlation can never succeed for it.',
      noFirstFrameRequired: 'E-BUNDLE-027: the official server method map `va` has no `initialize`, no `protocol/version` and no handshake method. Nothing must be sent first. The five unsolicited startup/storageState frames arrive with ZERO frames sent, which is exactly what the real captures show. Do NOT add an initialize frame to the allowlist.',
      startupReplyRemoved: 'I02-F4, coordinator-adjudicated: `startup/storagePathReady` is GONE from the allowlist, from the client options and from the P4 path. E-BUNDLE-026 shows the storagePath -> storagePathReady(reuse) -> storageState -> storagePrepared handshake belongs to the SEPARATE `zcode app-server --prepare-storage` mode; E-BUNDLE-023 shows the full app-server logs "ZCode Protocol notification ignored" for any frame with a method and no id. The round-3 run answered `{"independentPlanState":true}` with the reply in place and proved it inert, so keeping it meant every operator had to reason about a write that provably does nothing. It now classifies as potentially_model_dispatching, so even a direct request() is refused and counted. p4.controlFrames is back to 1.',
      correlationRule: 'I02-F3-3: a request now waits for a frame whose id EQUALS the id it sent, until the timeout. A rejection frame arriving first is recorded in p4.frameLog and does NOT end the wait, so a late real response is still found. p4.frameLog lists every inbound frame in arrival order with its official classification.',
      reDecide: 'COORDINATOR: run P4 with both flags. The expected result is unchanged from round 3 — p4.outcome "ok", p4.responseIdMatchedRequest true, p4.controlFrames 1 — and controlFrames is now 1 rather than 2, which is the visible consequence of the reply\'s removal. If p4.responseIdMatchedRequest is false, p4.diagnostics carries the official error code, message and zod issues and p4.frameLog shows every frame in order: that is the evidence to bring back.'
    }
  ];
  printJson({
    generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    note: 'P2-P4 start the official app-server and are for the COORDINATOR to run after reviewing this task. I02 itself ran none of them.',
    executionPreconditions: [
      '1. THESE ARE NOT READ-ONLY PROBES. P2, P3 and P4 start the REAL official app-server process. "Zero send" constrains what THIS PRODUCT writes, not what the official runtime does once it is running.',
      '2. LOCAL STORAGE MIGRATION WRITE. The startup sequence announces a storage path and a migration state, and the official phase enum (E-BUNDLE-016) contains "migrating" and "committing". Simply observing the handshake means the official runtime performs a migration write against the user\'s own ZCode local storage. That is unavoidable for P2/P3/P4 and is accepted knowingly.',
      '3. BACKGROUND DISPATCH CANNOT BE PREVENTED. The product matrix records automation_task_disable_scope as blocked: the runtime may create automation/off-peak tasks and issue unattended background turns on its own, and no official switch was found that stops it. A zero-send probe of this product does not guarantee the process stays quiet. This is a known, accepted, unresolved exposure.',
      '4. NO --surface ARGUMENT IS PASSED. The spawn arguments are exactly [cliPath, "app-server"] — no --surface, no --mode, no behavioural constraint of any kind. help states --surface accepts "terminal" or "desktop" (E-HELP-004) but the default was never established. TODO FOR THE COORDINATOR: decide whether to pass --surface, and which value. The argument list changes the official behaviour surface, so this task deliberately does NOT add the flag on its own.',
      '5. P4 WRITES EXACTLY ONE FRAME (I02-F4). P4 writes the runtime/capabilities readback to the live process and nothing else, and it is gated behind a second acknowledgement for that reason alone. The startup/storagePathReady reply that earlier rounds described as a possible second write has been REMOVED: it is not on the allowlist, not on the client options, and not reachable from this script. Do not expect controlFrames 2 — the acceptance number is 1.',
      '6. FRAME SHAPES ARE OFFICIAL, NOT GENERIC JSON-RPC (I02-F3-2). Every frame this product writes is {id, method, params} for a request and {method} for a notification; none carries a `jsonrpc` member, because the official schemas are strict and do not declare one (E-BUNDLE-021). The refusal frame written back down the reverse channel is {id, error:{code,message}} (E-BUNDLE-024).',
      '7. THE SERVER EXPOSES ITS OWN REJECTION (I02-F3-1). On the P4 path only, the reply frame\'s id value, error.code, error.message and error.data.issues[].path/code/message are printed, because they are protocol constants and validator diagnostics, not credentials. params and result values are still never printed, and redact() is applied twice. P2/P3 keep the value-free summary.'
    ],
    ledgerContract: 'Every step must end with ledger.modelDispatch === 0 AND ledger.modelDispatchAttempts === 0. modelDispatchAttempts counts a request for any non-allowlisted method, refused ones included, so it is a real observation rather than a counter that can only read zero. A non-zero value is a fail-closed abort, not a finding to work around.',
    refusalContract: 'ledger.refusedReverse > 0 is EXPECTED whenever the runtime asks for anything: every reverse request is answered with a JSON-RPC -32601 error carrying only the method name, never a value. Those writes are counted in ledger.refusalFrames and are excluded from ledger.controlFrames.',
    capabilityAfterThese: 'mechanism_verified at best. Running P2-P4 grants no upgrade by itself. The ONE row at behavior_verified (zero_send_startup_handshake) holds it from a reviewed coordinator capture of the real process (E-PROBE-R3-P4, in the matrix, cited as official_process_capture), not from a run of this script.',
    pin: runtime.OFFICIAL_RUNTIME_EVIDENCE_PIN,
    writeAllowlist: [...runtime.CONTROL_PLANE_METHODS.keys()],
    pendingReadOnlyMethods: [...runtime.PENDING_READ_ONLY_METHODS.keys()],
    steps
  });
  process.stderr.write('I02 probe-plan: printed only. Nothing was started, spawned or sent.\n');
  return 0;
}

/**
 * The real probe. Refuses to exist without an explicit human acknowledgement.
 *
 * I-1, and the reason this function had to grow a second door. Until the REV4
 * review, the report and `probe-plan` both promised a P4 that "sends
 * runtime/capabilities, and only that", and expected `controlFrames == 1`. There
 * was no such code path: `client.request()` was never called from this script at
 * all, `commandProbe` composed no frame, and an operator following the written
 * procedure would have got `controlFrames == 0` and then — by the report's OWN
 * acceptance rule — recorded a false drift against a real, correct runtime.
 *
 * The fix is option (a) of the review's two: the active readback is really
 * implemented, behind a SECOND, separate acknowledgement. It is not hidden in
 * the first one, because the first one authorises a passive observation and this
 * authorises a write to a live official process. An operator who has read only
 * the P2/P3 paragraph therefore still cannot write anything by accident.
 *
 * Without `--p4-active-readback-ack` this function remains strictly passive and
 * composes no frame at all.
 *
 * @param {any} runtime
 */
async function commandProbe(runtime) {
  if (!flags.has('--i02-real-probe-ack')) {
    process.stderr.write(
      'REFUSED: the real zero-send probe was not acknowledged.\n'
      + 'A human operator must pass --i02-real-probe-ack after reviewing this plan:\n'
      + '  1. spawn only the official CLI bundle, stdio, shell:false, minimal env;\n'
      + '  2. send ONLY methods on the control-plane allowlist, or a malformed frame;\n'
      + '  3. refuse every reverse request with a JSON-RPC error, including MCP/runtime auth headers;\n'
      + '  4. assert the model-dispatch counter is exactly 0 before reporting anything;\n'
      + '  5. never read a credential, never touch a production database, never send a model request.\n'
      + '  6. I02-F4: holding BOTH flags no longer arms a startup handshake reply. That reply was\n'
      + '     removed — it belongs to `app-server --prepare-storage` and this surface drops id-less\n'
      + '     notifications by design. P4 writes exactly one frame, the runtime/capabilities readback.\n'
    );
    return 3;
  }
  if (flags.has('--p4-active-readback-ack')) {
    // Second gate, checked before anything is constructed or spawned.
    process.stderr.write(
      'I02 real probe: P4 ACTIVE READBACK ARMED.\n'
      + 'This run will START the official app-server and WRITE exactly one frame to it.\n'
      + 'Before you run this, you must have read and accepted every item in\n'
      + '  probe-plan -> executionPreconditions (real runtime startup, local storage migration\n'
      + '  writes, background dispatch that cannot be prevented, and no --surface argument).\n'
    );
  }
  const timeoutRaw = values.get('--timeout-ms') ?? '5000';
  const timeoutMs = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail(2, `BAD_TIMEOUT: ${timeoutRaw}`);

  const cliPath = values.get('--cli') ?? 'C:/ZCode/resources/glm/zcode.cjs';
  const activeReadback = flags.has('--p4-active-readback-ack');
  const client = new runtime.NoSendStdioClient({
    command: process.execPath,
    args: [cliPath, 'app-server'],
    nonce: runtime.makeNonce(),
    requestTimeoutMs: timeoutMs,
    // I02-F4: the option that armed the startup/storagePathReady reply is GONE
    // from the client, so there is nothing to arm here. That handshake belongs
    // to the separate `app-server --prepare-storage` mode and this surface
    // discards id-less notifications by design (STARTUP_REPLY_SURFACE_FINDING;
    // E-BUNDLE-023/026). P4 writes exactly one frame now, and the round-3 real
    // run proved the readback does not need the other one.
    //
    // The pre-write notice. Printed to stderr, synchronously, immediately before
    // the corresponding bytes reach stdin, so the operator's terminal record
    // shows the exact line even if the child dies on the next instruction.
    onControlWrite: (/** @type {{method: string, line: string, why: string}} */ info) => {
      process.stderr.write(`I02 P4: about to send ONE request frame — ${info.line.trim()}\n`);
    }
  });
  let exitCode = 0;
  /**
   * I02-F2-4. ONE report object, printed exactly once.
   *
   * The pre-fix code called `printRedacted` twice — once for the passive
   * observation and once for the P4 block — so `probe-r1-p4.json` on disk is two
   * concatenated JSON documents and `JSON.parse` of it fails. A report that
   * cannot be parsed is not a report, so the accumulation is now explicit: the
   * sections are filled in as they become known and the whole document is
   * emitted once, after the child has been reclaimed, because `childStderr` and
   * the final ledger are only complete at that point.
   *
   * @type {any}
   */
  const report = { observation: null, ledger: null, fatal: null };
  try {
    client.start();
    process.stderr.write(`I02 real probe: child pid=${String(client.identity.pid)} nonce=${client.identity.nonce}\n`);

    // I-2. The passive observation. No frame is composed here — the startup
    // handshake direction is a fact to be READ, not guessed. What is printed is
    // the frame's SCHEMA SHAPE: the method name value (so the executor can tell
    // which of the three official startup variants arrived) and, for every field,
    // only its name, JSON type, string length in code units and in bytes, array
    // length, field count, and membership of an official enum or literal. No
    // path, no attemptId, no databaseId and no JSON-RPC id VALUE is ever
    // printed, which is what makes the E-BUNDLE-014/016 structural criteria
    // machine-evaluable from this output alone.
    const first = await client.nextFrame(timeoutMs);
    report.observation = first.kind === 'ok'
      ? { kind: 'ok', frameShape: runtime.describeFrameShape(first.frame) }
      : { kind: 'error', code: first.code, detail: first.detail };

    // I-1. The active readback, armed only by the second acknowledgement.
    if (activeReadback) {
      // I02-F2-3 drained the rest of the startup sequence here so that a reply
      // the server rejected would be visible instead of swallowed. With the reply
      // gone (I02-F4) the reason is gone too, and the drain would only add a
      // full timeout to every run: it used to stop on `startupReply.sent`, and
      // there is no longer a send to wait for.
      //
      // Nothing is lost by not waiting. `request()` records EVERY inbound frame
      // in `frameLog` and keeps waiting for the one whose id matches, so the
      // remaining storageState notifications are still classified, still in
      // order, and still in `observation.startupSequence` — which is recorded by
      // the transport on the way past, independently of any waiter.
      const P4_METHOD = 'runtime/capabilities';
      const expectedId = client.nextRequestId();
      // Printed BEFORE the send, on stderr, so the operator's terminal record
      // shows what went out even if the process dies immediately afterwards.
      //
      // I02-F3-2: the printed expectation now states the OFFICIAL response
      // shape. E-BUNDLE-021/024 show the official response is `{id, result}`
      // with no `jsonrpc` member, so an operator who sees a `jsonrpc` key in the
      // answer knows immediately that the peer is not this protocol.
      process.stderr.write(
        `I02 P4: about to send ONE frame — method "${P4_METHOD}", params {}.\n`
        + 'I02 P4: expecting {"id":"' + expectedId + '","result":{"independentPlanState":true}} — E-BUNDLE-003, E-BUNDLE-024,\n'
        + 'I02 P4: the official response frame carries NO jsonrpc member (E-BUNDLE-021 qir is .strict() and has no such slot).\n'
        + 'I02 P4: and ledger.controlFrames == 1 (this readback, and nothing else — I02-F4 removed the startup reply).\n'
        + 'I02 P4: if the result differs, record drift. Do NOT substitute the installed version.\n'
      );
      // I02-F3-3. `request()` now waits for a frame whose id EQUALS the id we
      // sent, until the timeout, and records every frame it saw in between. A
      // rejection frame that arrives first no longer ends the wait.
      const res = await client.request(P4_METHOD, {}, timeoutMs);
      const idMatched = res.kind === 'ok' && res.frame.id === expectedId;
      /**
       * F11. Set only on the correlated path, and only to say whether the
       * ANSWER was accepted — never to re-decide correlation.
       * @type {{accepted: boolean, frameKind: string, topLevelKeys: readonly string[], reasons: readonly string[]} | null}
       */
      let semanticVerdict = null;
      // I02-F3-1. Diagnostics are revealed HERE and only here. P2/P3 and the
      // passive observation above keep the value-free summary.
      const p4Shape = res.kind === 'ok'
        ? runtime.describeFrameShape(res.frame, { exposeProtocolDiagnostics: true })
        : null;
      if (res.kind !== 'ok') {
        process.stderr.write(`I02 P4: readback FAILED (${res.code}: ${res.detail}); no result to compare.\n`);
        process.stderr.write('I02 P4: the frames that DID arrive, in order, are in p4.frameLog below.\n');
        exitCode = 1;
      } else if (!idMatched) {
        process.stderr.write(
          `I02 P4: the frame answered carried id ${JSON.stringify(res.frame.id)}, not the ${expectedId} we sent.\n`
          + 'I02 P4: an id that is a fixed reason LITERAL means the server rejected the WHOLE MESSAGE at its\n'
          + 'I02 P4: schema gate (E-BUNDLE-022) rather than answering the request — see p4.diagnostics.\n'
        );
        exitCode = 1;
      } else {
        // F11. Correlation is NOT acceptance. The frame carries the id we sent;
        // from here the ANSWER has to be the official one, or the run failed.
        // A capability that reads false, a correlated error, or a frame with a
        // member the official `.strict()` schema does not declare are all drift.
        semanticVerdict = assessP4Semantics(res.frame, p4Shape, runtime);
        if (semanticVerdict.accepted) {
          process.stderr.write(
            `I02 P4: correlated. id ${expectedId} matched, result ${JSON.stringify(res.frame.result ?? null)}.\n`
          );
        } else {
          process.stderr.write(
            `I02 P4: correlated id ${expectedId} matched, but SEMANTIC ACCEPTANCE FAILED `
            + `(official classification: "${semanticVerdict.frameKind}"):\n`
          );
          for (const reason of semanticVerdict.reasons) {
            process.stderr.write(`I02 P4:   ${reason}\n`);
          }
          process.stderr.write(
            'I02 P4: this is drift in the readback, not a passing acceptance. Record it. Do NOT substitute\n'
            + 'I02 P4: the installed version, and do NOT treat a correlated frame as a verified capability.\n'
          );
          exitCode = 1;
        }
      }
      if (p4Shape !== null && p4Shape.errorValues !== null && p4Shape.errorValues.code !== null) {
        const ev = p4Shape.errorValues;
        process.stderr.write(
          `I02 P4: protocol diagnostics — code ${ev.code}, message ${JSON.stringify(ev.message)}, `
          + `id ${JSON.stringify(ev.idValue)} (${ev.idType}, ${String(ev.idStringLength ?? 'n/a')} chars), `
          + `${ev.issues.length} issue(s)\n`
        );
        for (const issue of ev.issues) {
          process.stderr.write(`I02 P4:   issue path=${JSON.stringify(issue.path)} code=${JSON.stringify(issue.code)} message=${JSON.stringify(issue.message)} keys=${JSON.stringify(issue.keys)}\n`);
          // I02-F3-2: the offending key of a union rejection is only named
          // inside the per-branch issues, so they are published too.
          for (const branch of issue.branches) {
            process.stderr.write(`I02 P4:     branch path=${JSON.stringify(branch.path)} code=${JSON.stringify(branch.code)} keys=${JSON.stringify(branch.keys)} message=${JSON.stringify(branch.message)}\n`);
          }
        }
      }
      const ledger = client.ledger;
      if (ledger.controlFrames !== 1) {
        process.stderr.write(
          `I02 P4: expected exactly 1 control frame (the readback), ledger says ${ledger.controlFrames}.\n`
        );
        exitCode = 1;
      }
      report.p4 = {
        method: P4_METHOD,
        params: {},
        expectedId,
        // Verbatim, because this one method's result is a compiled-in constant
        // per E-BUNDLE-003 and carries no runtime or user data. It is NOT read
        // back for any other method, by anything.
        result: res.kind === 'ok' ? res.frame.result ?? null : null,
        responseIdMatchedRequest: idMatched,
        /**
         * F11. `outcome` is now ONE verdict, not the transport's opinion, and it
         * has exactly three terminal states so the three failures stay
         * distinguishable in the data:
         *   `ok`                 — correlated AND the official answer
         *   `semantic_rejected`  — correlated, but the answer is not the official one
         *   `uncorrelated`       — a frame arrived, but not the one we asked
         * A frame that merely arrived is never `ok`. Reporting `ok` on a run
         * that exits non-zero would be the same class of defect this closes.
         */
        outcome: res.kind !== 'ok'
          ? res.code
          : (semanticVerdict === null ? 'uncorrelated' : (semanticVerdict.accepted ? 'ok' : 'semantic_rejected')),
        // F11. The semantic half, in full: the official classification of the
        // correlated frame, the key names it carried, and every reason it was
        // refused. null when nothing correlated.
        semanticAcceptance: semanticVerdict === null
          ? null
          : {
            accepted: semanticVerdict.accepted,
            frameKind: semanticVerdict.frameKind,
            topLevelKeys: semanticVerdict.topLevelKeys,
            reasons: semanticVerdict.reasons
          },
        outcomeDetail: res.kind === 'ok' ? null : res.detail,
        resultShape: p4Shape,
        // I02-F3-1. The revealed protocol diagnostics, or null when there was
        // no response frame at all. Never contains a params or result value.
        diagnostics: p4Shape === null ? null : p4Shape.errorValues,
        // I02-F3-3. Every inbound frame of this run, in arrival order, with its
        // official classification and whether it satisfied the pending request.
        frameLog: client.frameLog,
        controlFrames: ledger.controlFrames,
        // I02-F4. The startup frames are still counted as an observation, so a
        // reader can see that the sequence completed before the request was
        // answered. They are not control frames: nothing was written for them.
        startupFramesObserved: client.startupFrames.length,
        modelDispatch: ledger.modelDispatch,
        modelDispatchAttempts: ledger.modelDispatchAttempts,
        refusalFrames: ledger.refusalFrames
      };
    }
  } catch (e) {
    process.stderr.write(`I02 real probe failed: ${e instanceof Error ? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    const closed = await client.close();
    try { client.assertNoModelDispatch(); } catch (e) {
      process.stderr.write(`ZERO-SEND VIOLATION: ${e instanceof Error ? e.message : String(e)}\n`);
      exitCode = 1;
    }
    process.stderr.write(`I02 real probe: child reclaimed via our own handle only (stage=${closed.stage}).\n`);
    // I02-F2-2. Read AFTER the reclaim, because a child that dies on a fatal
    // error writes its reason last. Routed through `printRedacted`, so the whole
    // document — this field included — passes `redact()` and a secret-shaped
    // substring inside a crash dump is not published by being a crash dump.
    const stderrCapture = client.childStderr;
    report.observation = {
      ...(report.observation ?? { kind: 'error', code: 'CHILD_ERROR', detail: 'no observation was completed' }),      // The phase sequence, and the evidence the zero-send claim rests on.
      // Identifier values are still absent; `method` and `phase` are protocol
      // constants.
      startupSequence: client.startupFrames,
      // I02-F4. Not a reply record any more — it is the FINDING that removed the
      // reply, printed on every run so the absence is explained rather than
      // merely observed.
      startupReplySurfaceFinding: runtime.STARTUP_REPLY_SURFACE_FINDING,
      // I02-F3-3. Present on every run, passive or active: what arrived, in
      // order, and how the official guards classify each frame.
      frameLog: client.frameLog,
      childStderr: {
        text: stderrCapture.text,
        bytes: stderrCapture.bytes,
        truncated: stderrCapture.truncated,
        capBytes: stderrCapture.capBytes,
        empty: stderrCapture.text.trim().length === 0
      },
      childReclaim: { stage: closed.stage, pendingWaiters: closed.pendingWaiters }
    };
    report.ledger = client.ledger;
    report.fatal = client.fatal;
  }
  printRedacted(runtime, report);
  return exitCode;
}

const runtime = await loadRuntime();
let code = 1;
if (command === 'evidence') code = await commandEvidence(runtime);
else if (command === 'discovery') code = await commandDiscovery(runtime);
else if (command === 'contract') code = await commandContract();
else if (command === 'probe-plan') code = await commandProbePlan(runtime);
else if (command === 'probe') code = await commandProbe(runtime);
else fail(2, `UNKNOWN_COMMAND: ${String(command)}\n${USAGE}`);

process.exit(code);
