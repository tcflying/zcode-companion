/**
 * discovery.ts — I02 official runtime layer discovery.
 *
 * WHAT THIS FILE IS
 *   A read-only observer for the three official runtime layers. It answers
 *   exactly one question per layer: "is the file we are about to treat as the
 *   official entry point actually that file, and what is its content identity?"
 *
 * THE THREE LAYERS ARE NOT INTERCHANGEABLE (hard product rule)
 *   L1 `desktop_asar`  the statically installed desktop package.
 *                      Its version is a property of the FILE, never of a
 *                      running process.
 *   L2 `cli_bundle`    the CLI bundle we would spawn.
 *                      Its version comes from `node <bundle> --version`, i.e.
 *                      from the file being executed, not from the installation.
 *   L3 `live_host`     the process that is actually running right now.
 *                      I02 does NOT start, stop, attach to, query or enumerate
 *                      any official process. It therefore stays
 *                      `unknown_by_design` forever in this build. An installed
 *                      version MUST NOT be substituted for it.
 *
 * WHAT THIS FILE IS NOT
 *   It does not launch the app-server, does not authenticate, does not read or
 *   decrypt any credential, and does not open any user/session database. It
 *   spawns exactly two kinds of child process, both read-only and both bounded:
 *   `<bundle> --version` and `<bundle> --help`.
 *
 * Evidence discipline: every field is either measured here, copied from the
 * frozen I00 baseline, or explicitly `null` with a reason. Nothing is inferred
 * from a file name. "Unknown" is a first-class, expected result.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/* ------------------------------------------------------------------ *
 * Frozen inputs (I00 — read-only, never rewritten by this task)
 * ------------------------------------------------------------------ */

/** Default official paths. Overridable per call; never auto-discovered by guess. */
export const OFFICIAL_RUNTIME_DEFAULTS = {
  cliBundlePath: 'C:/ZCode/resources/glm/zcode.cjs',
  desktopAsarPath: 'C:/ZCode/resources/app.asar'
} as const;

export interface BaselineFingerprint {
  readonly observedAtUtc: string;
  readonly baselineFile: string;
  readonly inputsDoc: string;
  readonly cliSha256: string;
  readonly cliVersion: string;
  readonly asarSha256: string;
  readonly desktopVersion: string;
}

/** Verbatim from review-artifacts/929/baseline.json (I00). Do not edit here. */
export const I00_BASELINE: BaselineFingerprint = {
  observedAtUtc: '2026-09-29T06:24:35Z',
  baselineFile: 'review-artifacts/929/baseline.json',
  inputsDoc: 'docs/decisions/929-inputs.md',
  cliSha256: 'fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f',
  cliVersion: '0.16.9',
  asarSha256: '172d6f333e61642ce3882250949fafe8180f75b5b8e5552244ca2c59ca05d14e',
  desktopVersion: '3.14.4'
};

/* ------------------------------------------------------------------ *
 * Child-process environment discipline
 * ------------------------------------------------------------------ */

/**
 * Variables forwarded to any child we spawn. Allowlist, not denylist: a
 * variable that is not listed here is not inherited, so a new injection vector
 * added to the ambient environment cannot reach our child by default.
 * Windows needs the system variables for `CreateProcess` to work at all; the
 * rest is the minimum that keeps a console Node child functional.
 *
 * I02-F2-1 — the two `ZCODE_*PROVIDER_CONFIG_FILE` entries are NOT a guess and
 * are NOT "because the CLI might want them". They were added because the
 * allowlist as it stood was measurably too narrow: with exactly the original 19
 * names, the official CLI printed
 *   无法定位 CLI ZCode Built-in Provider Config：C:\ZCode\resources\glm\provider\zcode-builtin.json, C:\config\provider\zcode-builtin.json
 * and exited with zero stdout. See review-artifacts/929/probe-r1-diagnosis.json
 * variant D, and the bisection table in task-I02-report.md §11.1. The two names
 * below are the complete minimal set: EXP-ENV-V5 forwarded those two and
 * NOTHING else (no PATH, no SystemRoot, no APPDATA) and the runtime started
 * normally, 5 startup frames; EXP-ENV-V1 forwarded the original 19 and the
 * runtime produced 0 frames; EXP-ENV-V6/V7/V8/V9 each added one further
 * candidate to the original 19 (ALLUSERSPROFILE, USERNAME,
 * ZCODE_WINDOWS_APP_INSTALL_DIR, ZCODE_APP_VERSION+ZCODE_BASE_URL) and every
 * one of them still produced 0 frames.
 *
 * WHAT THIS FORWARDS IS A PATH, NOT A SECRET. Both values are filesystem paths
 * that the official runtime resolves and then reads itself. This product never
 * opens, reads, decrypts, hashes or prints either path's contents, and
 * `EnvSanitizeReport` carries names only. A key whose NAME is credential-shaped
 * is still hard-refused below — the pair above does not match that pattern and
 * is admitted because the runtime does not start without it, which is a
 * measured fact (EXP-ENV-V1 vs EXP-ENV-V2), not a relaxation of the rule.
 */
const ENV_ALLOWLIST = [
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'SystemDrive',
  'ProgramFiles',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  // EXP-ENV-V1 -> EXP-ENV-V2 / EXP-ENV-V5 / EXP-ENV-R2-1: without this exact
  // name the official app-server prints "无法定位 CLI ZCode Built-in Provider
  // Config" and produces no frames at all. With it and nothing else, it starts.
  'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  // EXP-ENV-R2-1 vs EXP-ENV-R2-2: forwarding the built-in path ALONE starts the
  // runtime (5 frames) but the run then ends with "Error: Protocol input
  // closed" on stderr; forwarding the personal path ALONE fails the same way
  // the missing case does. The official bundle pairs them, so both are
  // forwarded: the value forwarded is a path, and the product still reads
  // neither file.
  'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'
] as const;

/**
 * Hard-denied even if the allowlist were widened later. These are the injection
 * and credential carriers named by the I02 contract.
 */
export const ENV_ALWAYS_DENIED = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_DEBUG',
  'NODE_NO_WARNINGS',
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_USERCONFIG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY'
] as const;

/** Credential-shaped names are dropped regardless of the allowlist. */
const CREDENTIAL_NAME = /(token|secret|password|passwd|apikey|api_key|credential|cookie|authorization|bearer|session_key|private_key)/i;

export interface EnvSanitizeReport {
  readonly forwarded: readonly string[];
  readonly denied: readonly string[];
  /**
   * NAMES of variables withheld for looking credential-shaped. Never values.
   *
   * Named `withheldNames` rather than `droppedByCredentialName` because this
   * report is passed through `redact()`, whose key pattern includes
   * /credential/i: the old field name matched it and was replaced by
   * "[REDACTED]", hiding the very evidence that environment sanitisation ran.
   */
  readonly withheldNames: readonly string[];
}

/**
 * Builds the minimal environment for a read-only child.
 * @returns the env to use plus a report of what was dropped (names only — never values).
 */
export function sanitizeEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {}
): { env: NodeJS.ProcessEnv; report: EnvSanitizeReport } {
  const forwarded: string[] = [];
  const denied: string[] = [];
  const withheldNames: string[] = [];
  const env: NodeJS.ProcessEnv = {};

  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value === undefined) continue;
    if (CREDENTIAL_NAME.test(key)) {
      withheldNames.push(key);
      continue;
    }
    env[key] = value;
    forwarded.push(key);
  }

  for (const key of Object.keys(source)) {
    if (key in env) continue;
    if ((ENV_ALWAYS_DENIED as readonly string[]).includes(key)) {
      denied.push(key);
      continue;
    }
    if (CREDENTIAL_NAME.test(key)) withheldNames.push(key);
  }

  for (const [key, value] of Object.entries(extra)) {
    if (CREDENTIAL_NAME.test(key)) {
      // Refuse to inject a credential-shaped variable at all.
      withheldNames.push(key);
      continue;
    }
    env[key] = value;
    if (!forwarded.includes(key)) forwarded.push(key);
  }

  return {
    env,
    report: { forwarded: forwarded.sort(), denied: denied.sort(), withheldNames: [...new Set(withheldNames)].sort() }
  };
}

/* ------------------------------------------------------------------ *
 * Bounded read-only child execution
 * ------------------------------------------------------------------ */

export interface BoundedRunOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Cap on captured stdout/stderr; excess is truncated and flagged. */
  readonly maxCaptureBytes?: number;
  readonly envSource?: NodeJS.ProcessEnv;
  readonly envExtra?: Readonly<Record<string, string>>;
}

export interface BoundedRunResult {
  readonly argvDisplay: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly spawnError: string | null;
  readonly pid: number | null;
  readonly envReport: EnvSanitizeReport;
}

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_BYTES = 4 * 1024 * 1024;

/**
 * Runs one read-only child to completion under a hard time bound.
 *
 * Resource contract:
 *  - `shell: false` always; the argument vector is passed as an array, never
 *    through a command string, so no metacharacter can be interpreted.
 *  - Only the handle returned by this call is ever signalled. There is no
 *    name-based, port-based or wildcard kill anywhere in this module.
 *  - Every timer and every stream listener created here is removed before the
 *    returned promise settles, on the success path and on the error path.
 *  - The process is never aborted via `process.exit()`.
 *
 * @returns exit code, captured output and whether the bound was hit.
 */
export function runBoundedReadOnlyCommand(options: BoundedRunOptions): Promise<BoundedRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  const { env, report } = sanitizeEnv(options.envSource ?? process.env, options.envExtra ?? {});
  const startedAt = Date.now();
  const argvDisplay = [options.executable, ...options.args].join(' ');

  return new Promise<BoundedRunResult>((resolvePromise) => {
    // REV4 m-4. Captured bytes are buffered as `Buffer` and decoded ONCE, at
    // settle. The previous version did `stdout += chunk.toString('utf8')` per
    // chunk, which is wrong for any text containing a multi-byte character: a
    // CJK glyph or an emoji that straddles a chunk boundary is decoded as two
    // U+FFFD and the string's character count no longer matches its byte count.
    //
    // It did not fire on this machine only because the help text is pure ASCII
    // (3334 chars == 3334 bytes). Any real help/usage text in the wild contains
    // UTF-8, and the consequence is not cosmetic: the product's own rule reads a
    // change in `helpTextSha256` as "help drifted, therefore every help-derived
    // conclusion is void". A decode artefact would fabricate exactly that.
    // Byte-level framing in capability-probe.ts already had this right; this
    // path did not, and it had no test.
    /** @type {Buffer[]} */
    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    /** @type {Buffer[]} */
    let stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** @param {Buffer[]} chunks @returns {string} */
    const decodeOnce = (chunks: Buffer[]): string =>
      new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));

    /** @param {Buffer} chunk @param {boolean} isStdout */
    const capture = (chunk: Buffer, isStdout: boolean): void => {
      const used = isStdout ? stdoutBytes : stderrBytes;
      const room = maxCaptureBytes - used;
      if (room <= 0) {
        if (isStdout) stdoutTruncated = true; else stderrTruncated = true;
        return;
      }
      // A truncation that lands mid-character decodes to a single U+FFFD at the
      // very end. That is correct: the alternative (padding a partial sequence)
      // would report bytes the process never emitted.
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      if (slice.byteLength < chunk.byteLength) {
        if (isStdout) stdoutTruncated = true; else stderrTruncated = true;
      }
      if (isStdout) { stdoutChunks.push(slice); stdoutBytes += slice.byteLength; return; }
      stderrChunks.push(slice); stderrBytes += slice.byteLength;
    };

    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd ?? process.cwd(),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const pid = typeof child.pid === 'number' ? child.pid : null;

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const onStdout = (/** @type {Buffer} */ d: Buffer): void => { capture(d, true); };
    const onStderr = (/** @type {Buffer} */ d: Buffer): void => { capture(d, false); };
    stdoutStream?.on('data', onStdout);
    stderrStream?.on('data', onStderr);

    const onChildError = (err: Error): void => settle(null, null, `${err.name}: ${err.message}`);
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => settle(code, signal, null);

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      stdoutStream?.off('data', onStdout);
      stderrStream?.off('data', onStderr);
      stdoutStream?.destroy();
      stderrStream?.destroy();
      // Detach our own child listeners too: no listener this function created
      // may outlive the returned promise.
      child.off('error', onChildError);
      child.off('close', onChildClose);
    };

    /**
     * @param {number | null} exitCode
     * @param {NodeJS.Signals | null} signal
     * @param {string | null} spawnError
     */
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        argvDisplay,
        exitCode,
        signal,
        timedOut,
        stdout: decodeOnce(stdoutChunks),
        stderr: decodeOnce(stderrChunks),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
        spawnError,
        pid,
        envReport: report
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Our own handle only. Never by name, never by port, never a wildcard.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // Give the OS a bounded moment to report close; settle regardless so no
      // pending waiter can outlive the bound.
      setTimeout(() => settle(null, null, null), 2000).unref();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', onChildError);
    child.on('close', onChildClose);
  });
}

/* ------------------------------------------------------------------ *
 * Static file identity
 * ------------------------------------------------------------------ */

export type RuntimeLayerId = 'desktop_asar' | 'cli_bundle' | 'live_host';

/**
 * How strongly the declared path was shown to BE the official artifact.
 *  - `content_verified`  real path resolved, regular file, SHA-256 computed and
 *                        (when an I00 baseline exists) equal to it.
 *  - `content_unverified` real path resolved and hashed, but no baseline to
 *                        compare against, so "official" is not established.
 *  - `shim_suspected`    measurable evidence of a wrapper rather than the
 *                        artifact (see `identityReasons`).
 *  - `unknown`           not measurable from the filesystem alone.
 */
export type IdentityConfidence = 'content_verified' | 'content_unverified' | 'shim_suspected' | 'unknown';

export type ObservationStatus = 'observed' | 'not_observed' | 'unknown_by_design';

export interface HashComparison {
  readonly baselineSha256: string | null;
  readonly observedSha256: string | null;
  readonly result: 'match' | 'drift' | 'no_baseline' | 'not_hashed';
}

export interface RuntimeLayerObservation {
  readonly layer: RuntimeLayerId;
  readonly declaredPath: string;
  readonly canonicalPath: string | null;
  readonly observation: ObservationStatus;
  readonly exists: boolean;
  readonly isRegularFile: boolean;
  readonly isLink: boolean;
  readonly sizeBytes: number | null;
  readonly leadingSignatureHex: string | null;
  readonly sha256: string | null;
  readonly version: string | null;
  /** Exactly how the version string was obtained. `null` when not measured. */
  readonly versionMethod: string | null;
  readonly versionSource: string | null;
  readonly identityConfidence: IdentityConfidence;
  readonly identityReasons: readonly string[];
  readonly hashComparison: HashComparison;
  readonly observedAtUtc: string;
  readonly notes: readonly string[];
}

/** Reads at most 4 leading bytes; used only to detect a Windows PE wrapper. */
function readLeadingSignature(path: string, length = 4): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read).toString('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Streams a file through SHA-256 without ever holding the whole file in memory. */
export async function sha256File(path: string, maxBytes?: number): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    let bytes = 0;
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      stream.off('error', onError);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.destroy();
      resolvePromise(value);
    };
    const onData = (chunk: string | Buffer): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += buf.byteLength;
      if (maxBytes !== undefined && bytes > maxBytes) {
        finish(null);
        return;
      }
      hash.update(buf);
    };
    const onEnd = (): void => { finish(hash.digest('hex')); };
    const onError = (): void => { finish(null); };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

export interface StaticFileInspection {
  readonly canonicalPath: string | null;
  readonly exists: boolean;
  readonly isRegularFile: boolean;
  readonly isLink: boolean;
  readonly sizeBytes: number | null;
  readonly leadingSignatureHex: string | null;
  readonly identityConfidence: IdentityConfidence;
  readonly identityReasons: readonly string[];
}

const WINDOWS_PE_SIGNATURE = '4d5a';

/**
 * Filesystem-only identity inspection. Makes no claim about officialness —
 * that claim is only upgraded when a baseline hash comparison is added.
 * @param declaredPath path as the product would use it
 * @param installRoot  the directory the artifact is expected to live under
 */
export function inspectStaticFile(declaredPath: string, installRoot: string): StaticFileInspection {
  const reasons: string[] = [];
  let canonicalPath: string | null = null;
  let exists = false;
  let isRegularFile = false;
  let isLink = false;
  let sizeBytes: number | null = null;

  try {
    const linkStat = lstatSync(declaredPath);
    exists = true;
    isLink = linkStat.isSymbolicLink();
    if (isLink) reasons.push('declared path is a symbolic link; its target is resolved separately');
  } catch {
    reasons.push('declared path does not exist on this filesystem');
    return {
      canonicalPath: null,
      exists: false,
      isRegularFile: false,
      isLink: false,
      sizeBytes: null,
      leadingSignatureHex: null,
      identityConfidence: 'unknown',
      identityReasons: reasons
    };
  }

  try {
    canonicalPath = realpathSync(declaredPath);
  } catch {
    canonicalPath = null;
    reasons.push('realpath could not be resolved (broken link or permission denied)');
  }

  try {
    const targetStat = statSync(declaredPath);
    isRegularFile = targetStat.isFile();
    sizeBytes = targetStat.isFile() ? targetStat.size : null;
  } catch {
    reasons.push('stat() failed after lstat() succeeded');
  }

  if (!isRegularFile) {
    reasons.push('target is not a regular file');
    return {
      canonicalPath,
      exists,
      isRegularFile: false,
      isLink,
      sizeBytes,
      leadingSignatureHex: null,
      identityConfidence: 'unknown',
      identityReasons: reasons
    };
  }

  const signature = readLeadingSignature(declaredPath);
  if (signature !== null && signature.startsWith(WINDOWS_PE_SIGNATURE)) {
    reasons.push('leading bytes are 4d5a (MZ): a Windows PE executable, i.e. a launcher wrapper rather than a JS runtime bundle');
  }

  if (canonicalPath !== null) {
    const root = resolve(installRoot);
    const target = resolve(canonicalPath);
    if (target !== root && !target.startsWith(root + sep)) {
      reasons.push(`canonical target escapes the declared install root (${installRoot})`);
      return {
        canonicalPath,
        exists,
        isRegularFile,
        isLink,
        sizeBytes,
        leadingSignatureHex: signature,
        identityConfidence: 'shim_suspected',
        identityReasons: reasons
      };
    }
  }

  reasons.push('path resolves inside the declared install root and is a regular file');
  return {
    canonicalPath,
    exists,
    isRegularFile: true,
    isLink,
    sizeBytes,
    leadingSignatureHex: signature,
    identityConfidence: 'unknown',
    identityReasons: reasons
  };
}

/* ------------------------------------------------------------------ *
 * Layer observation
 * ------------------------------------------------------------------ */

export type HashTarget = 'none' | 'cli' | 'asar' | 'all';

export interface DiscoveryOptions {
  readonly cliBundlePath?: string;
  readonly desktopAsarPath?: string;
  readonly installRoot?: string;
  readonly hash?: HashTarget;
  /** Run `<cli> --version` (read-only). Defaults to false: no child at all. */
  readonly readCliVersion?: boolean;
  /** Run `<cli> --help` (read-only). Defaults to false. */
  readonly readCliHelp?: boolean;
  readonly timeoutMs?: number;
}

export interface CliVersionReading {
  readonly attempted: boolean;
  readonly argvDisplay: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly rawStdout: string;
  readonly parsedVersion: string | null;
  readonly stderrSummary: string;
  readonly envReport: EnvSanitizeReport;
  readonly observedAtUtc: string;
}

export interface CliHelpReading {
  readonly attempted: boolean;
  readonly argvDisplay: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly helpText: string;
  readonly helpTextSha256: string;
  readonly stderrSummary: string;
  readonly observedAtUtc: string;
}

export interface RuntimeDiscoveryReport {
  readonly observedAtUtc: string;
  readonly baseline: BaselineFingerprint;
  readonly layers: readonly RuntimeLayerObservation[];
  readonly cliVersion: CliVersionReading;
  readonly cliHelp: CliHelpReading;
  /** Machine-readable verdict per layer. Never "ready". */
  readonly summary: {
    readonly cliIdentity: IdentityConfidence;
    readonly desktopIdentity: IdentityConfidence;
    readonly liveHostStatus: ObservationStatus;
    /**
     * True only when a layer this task set out to observe could not be verified.
     * A layer that is `unknown_by_design` is NOT blocked — see the REV4 m-5 note
     * at the construction site. `unverifiedLayers` names them so a `true` is
     * actionable instead of a bare alarm.
     */
    readonly anyLayerBlocked: boolean;
    readonly unverifiedLayers: readonly RuntimeLayerId[];
  };
}

const NO_ATTEMPT: CliVersionReading = {
  attempted: false,
  argvDisplay: '',
  exitCode: null,
  timedOut: false,
  rawStdout: '',
  parsedVersion: null,
  stderrSummary: 'not attempted',
  envReport: { forwarded: [], denied: [], withheldNames: [] },
  observedAtUtc: ''
};

const NO_HELP: CliHelpReading = {
  attempted: false,
  argvDisplay: '',
  exitCode: null,
  timedOut: false,
  helpText: '',
  helpTextSha256: '',
  stderrSummary: 'not attempted',
  observedAtUtc: ''
};

/** `zcode 0.16.9` / `0.16.9` / `0.16.9\n` → `0.16.9`; anything else → null. */
export function parseCliVersion(rawStdout: string): string | null {
  const firstLine = rawStdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (firstLine === undefined) return null;
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(firstLine);
  return match?.[1] ?? null;
}

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Observes all three layers without ever starting the official runtime.
 * @param options which read-only child commands (if any) may run
 */
export async function discoverRuntime(options: DiscoveryOptions = {}): Promise<RuntimeDiscoveryReport> {
  const cliPath = options.cliBundlePath ?? OFFICIAL_RUNTIME_DEFAULTS.cliBundlePath;
  const asarPath = options.desktopAsarPath ?? OFFICIAL_RUNTIME_DEFAULTS.desktopAsarPath;
  const installRoot = options.installRoot ?? 'C:/ZCode';
  const hashTarget = options.hash ?? 'none';
  const observedAtUtc = nowUtc();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  /* --- L1: static desktop ASAR (file property only) --- */
  const asarInspect = inspectStaticFile(asarPath, installRoot);
  const asarSha = hashTarget === 'asar' || hashTarget === 'all' ? await sha256File(asarPath) : null;
  const asarLayer: RuntimeLayerObservation = {
    layer: 'desktop_asar',
    declaredPath: asarPath,
    canonicalPath: asarInspect.canonicalPath,
    observation: asarInspect.exists ? 'observed' : 'not_observed',
    exists: asarInspect.exists,
    isRegularFile: asarInspect.isRegularFile,
    isLink: asarInspect.isLink,
    sizeBytes: asarInspect.sizeBytes,
    leadingSignatureHex: asarInspect.leadingSignatureHex,
    sha256: asarSha,
    version: null,
    versionMethod: null,
    versionSource: null,
    identityConfidence: asarInspect.identityConfidence === 'shim_suspected'
      ? 'shim_suspected'
      : asarSha !== null && asarSha === I00_BASELINE.asarSha256
        ? 'content_verified'
        : asarSha !== null
          ? 'content_unverified'
          : asarInspect.identityConfidence,
    identityReasons: [
      ...asarInspect.identityReasons,
      'desktop version is NOT read here: the ASAR header version belongs to the installed file and must never stand in for a running process version'
    ],
    hashComparison: {
      baselineSha256: I00_BASELINE.asarSha256,
      observedSha256: asarSha,
      result: asarSha === null ? 'not_hashed' : asarSha === I00_BASELINE.asarSha256 ? 'match' : 'drift'
    },
    observedAtUtc,
    notes: [
      `I00 baseline recorded @zcode/desktop ${I00_BASELINE.desktopVersion}; this task does not re-extract it and does not assert it.`
    ]
  };

  /* --- L2: CLI bundle (the spawn target) --- */
  const cliInspect = inspectStaticFile(cliPath, installRoot);
  const cliSha = hashTarget === 'cli' || hashTarget === 'all' ? await sha256File(cliPath) : null;

  /* --- L2b: read-only version reading from the file itself --- */
  let cliVersionReading: CliVersionReading = NO_ATTEMPT;
  if (options.readCliVersion === true) {
    const run = await runBoundedReadOnlyCommand({ executable: process.execPath, args: [cliPath, '--version'], timeoutMs });
    cliVersionReading = {
      attempted: true,
      argvDisplay: run.argvDisplay,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      rawStdout: run.stdout,
      parsedVersion: run.exitCode === 0 && !run.timedOut ? parseCliVersion(run.stdout) : null,
      stderrSummary: run.stderr.slice(0, 200),
      envReport: run.envReport,
      observedAtUtc: nowUtc()
    };
  }

  let cliHelpReading: CliHelpReading = NO_HELP;
  if (options.readCliHelp === true) {
    const run = await runBoundedReadOnlyCommand({ executable: process.execPath, args: [cliPath, '--help'], timeoutMs });
    cliHelpReading = {
      attempted: true,
      argvDisplay: run.argvDisplay,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      helpText: run.stdoutTruncated ? '' : run.stdout,
      helpTextSha256: createHash('sha256').update(run.stdout).digest('hex'),
      stderrSummary: run.stderr.slice(0, 200),
      observedAtUtc: nowUtc()
    };
  }

  const cliLayer: RuntimeLayerObservation = {
    layer: 'cli_bundle',
    declaredPath: cliPath,
    canonicalPath: cliInspect.canonicalPath,
    observation: cliInspect.exists ? 'observed' : 'not_observed',
    exists: cliInspect.exists,
    isRegularFile: cliInspect.isRegularFile,
    isLink: cliInspect.isLink,
    sizeBytes: cliInspect.sizeBytes,
    leadingSignatureHex: cliInspect.leadingSignatureHex,
    sha256: cliSha,
    version: cliVersionReading.parsedVersion,
    versionMethod: cliVersionReading.attempted
      ? `executed \`node <bundle> --version\` (exit ${String(cliVersionReading.exitCode)})`
      : null,
    versionSource: cliVersionReading.attempted ? cliVersionReading.argvDisplay : null,
    identityConfidence: cliInspect.identityConfidence === 'shim_suspected'
      ? 'shim_suspected'
      : cliSha !== null && cliSha === I00_BASELINE.cliSha256
        ? 'content_verified'
        : cliSha !== null
          ? 'content_unverified'
          : cliInspect.identityConfidence,
    identityReasons: cliInspect.identityReasons,
    hashComparison: {
      baselineSha256: I00_BASELINE.cliSha256,
      observedSha256: cliSha,
      result: cliSha === null ? 'not_hashed' : cliSha === I00_BASELINE.cliSha256 ? 'match' : 'drift'
    },
    observedAtUtc,
    notes: cliVersionReading.parsedVersion !== null && cliVersionReading.parsedVersion !== I00_BASELINE.cliVersion
      ? [`version drift versus I00 baseline (${I00_BASELINE.cliVersion}) — every prior help-derived claim must be re-sourced`]
      : []
  };

  /* --- L3: the running host. Deliberately never observed here. --- */
  const liveHostLayer: RuntimeLayerObservation = {
    layer: 'live_host',
    declaredPath: '(no path — a process, not a file)',
    canonicalPath: null,
    observation: 'unknown_by_design',
    exists: false,
    isRegularFile: false,
    isLink: false,
    sizeBytes: null,
    leadingSignatureHex: null,
    sha256: null,
    version: null,
    versionMethod: null,
    versionSource: null,
    identityConfidence: 'unknown',
    identityReasons: [
      'I02 does not start, stop, attach to, query or enumerate any official process',
      'an installed version is a property of a file and is never a substitute for the version of a running process'
    ],
    hashComparison: { baselineSha256: null, observedSha256: null, result: 'no_baseline' },
    observedAtUtc,
    notes: ['I00 also recorded runningHostVersion = NOT_VERIFIED; this task does not change that. ']
  };

  const layers = [liveHostLayer, cliLayer, asarLayer];

  /**
   * REV4 m-5. The previous expression counted `live_host` — whose observation is
   * `unknown_by_design` and always will be, because I02 never starts, stops,
   * attaches to or enumerates an official process — as a blocked layer. The flag
   * was therefore ALWAYS true, and the CLI printed "at least one layer is not
   * content-verified" even on a run where cli_bundle and desktop_asar were both
   * `content_verified` with a matching hash. A P1 run that passed every one of
   * its acceptance criteria still announced a failure, which teaches the
   * executor to ignore the warning and therefore also to ignore a real one.
   *
   * The fix is a definition, not an exception: "blocked" now means a layer this
   * task set out to observe and could NOT reach `content_verified`. A layer that
   * was never going to be observed is reported by `liveHostStatus` instead,
   * which is already in this report and says `unknown_by_design` out loud.
   */
  const unverifiedByObservation = layers.filter(
    (l) => l.observation !== 'unknown_by_design' && l.identityConfidence !== 'content_verified'
  );

  return {
    observedAtUtc,
    baseline: I00_BASELINE,
    layers,
    cliVersion: cliVersionReading,
    cliHelp: cliHelpReading,
    summary: {
      cliIdentity: cliLayer.identityConfidence,
      desktopIdentity: asarLayer.identityConfidence,
      liveHostStatus: liveHostLayer.observation,
      anyLayerBlocked: unverifiedByObservation.length > 0,
      unverifiedLayers: unverifiedByObservation.map((l) => l.layer)
    }
  };
}

/** Convenience for the CLI: the directory a layer is expected to live under. */
export function installRootOf(declaredPath: string): string {
  return dirname(declaredPath);
}
