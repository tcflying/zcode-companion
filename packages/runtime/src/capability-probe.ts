/**
 * capability-probe.ts — I02 zero-send capability model + bounded transport.
 *
 * THE ONE RULE THIS FILE ENFORCES
 *   No frame that could make the official runtime talk to a provider is ever
 *   written to a child. That is a structural property of the write path
 *   (`classifyMethod` in `request()`), not a promise in a report: a method that
 *   is not on the control-plane allowlist is refused before a single byte reaches
 *   the pipe.
 *
 *   Two counters back that up, and BOTH have real increment points, so neither
 *   is a decoration. `modelDispatch` increments at the one place bytes reach
 *   stdin. `modelDispatchAttempts` increments on the refusal path, so asking for
 *   a dispatching method leaves a trace even though nothing was sent. See I-3 in
 *   `assertNoModelDispatch`.
 *
 *   ONE HONEST EXCEPTION, stated here rather than buried: this file DOES write
 *   bytes in one situation — it answers a reverse request from the runtime with
 *   a JSON-RPC -32601 error. That is a refusal, not work, it never touches the
 *   allowlist, and it is counted in `refusalFrames` so no report can imply this
 *   product stayed silent. See I-4 in `handleReverseRequest`.
 *
 * MECHANISM vs BEHAVIOUR (the distinction the product depends on)
 *   `mechanism_verified` means: an official source states the mechanism AND the
 *   product can read it back with a zero-send read AND, for anything safety
 *   bearing, the control surface is complete. It does NOT mean a single
 *   provider request has ever succeeded.
 *   `behavior_verified` requires an OBSERVED REAL RUN of the official process
 *   by a human-reviewed capture — never a fixture, and never a consequence of
 *   running the probe. I02 has no plan allowance, so no row claims a behaviour
 *   this product has not watched the official runtime perform. As of I02-F4
 *   exactly one row holds it (`zero_send_startup_handshake`, on
 *   E-PROBE-R3-P4) and it is a pure observation: a server that performs the
 *   whole startup announcement by itself grants no send right, no entitlement
 *   and no usage. The rule is NARROWED (REV8 §4) and is executable — see
 *   `behaviourClaimRefusal`. A capture may raise an OBSERVATION row, but it may
 *   NEVER unlock a `blocking: true` ACTION row (those need a product behaviour
 *   acceptance), never turn `blocked` into this state, and never support
 *   `mechanism_verified`.
 *   Everything else is `unknown` or `blocked`. `unknown` means "no official
 *   source was found"; `blocked` means "a required control surface is not
 *   established, therefore the product must refuse". The default is unknown.
 *
 * The official method names quoted below are the method-string constants found
 * by read-only static inspection of the official CLI bundle. They are evidence
 * that a method name EXISTS in the shipped bundle. They are NOT a verified
 * schema: no frame in this file was ever accepted by the real runtime.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  EnvSanitizeReport,
  BoundedRunResult,
  RuntimeDiscoveryReport,
  RuntimeLayerObservation,
  IdentityConfidence
} from './discovery.js';

/**
 * Environment policy and the read-only discovery surface are shared with
 * discovery.ts so the two modules can never drift apart on a security-relevant
 * rule. This project's tsconfig (I01-owned, not editable by I02) forbids a
 * literal `.ts` import specifier, and Node needs the real `.ts` file at
 * runtime, so the specifier travels through a variable. The cast pins the
 * shape; the import itself is ordinary.
 */
const DISCOVERY_SPECIFIER = './discovery.ts';
const discovery = (await import(DISCOVERY_SPECIFIER)) as typeof import('./discovery.js');
const sanitizeEnv = discovery.sanitizeEnv;

/** Re-exported so callers need exactly one import of this package. */
export const discoverRuntime = discovery.discoverRuntime;
export const parseCliVersion = discovery.parseCliVersion;
export const I00_BASELINE = discovery.I00_BASELINE;
export const OFFICIAL_RUNTIME_DEFAULTS = discovery.OFFICIAL_RUNTIME_DEFAULTS;
export const ENV_ALWAYS_DENIED = discovery.ENV_ALWAYS_DENIED;
export type {
  EnvSanitizeReport,
  BoundedRunResult,
  RuntimeDiscoveryReport,
  RuntimeLayerObservation,
  IdentityConfidence
};

/* ================================================================== *
 * 1. Evidence primitives
 * ================================================================== */

/**
 * `official_process_capture` (I02-F4) is an OBSERVATION of the real official
 * process, not a reading of its source. It is a strictly stronger kind of
 * evidence about behaviour and a strictly weaker kind about mechanism: it can
 * only ever support a `behavior_verified` state, never a `mechanism_verified`
 * one, because it shows what a run did and nothing about why.
 */
export type EvidenceLayer = 'official_help_text' | 'official_static_bundle' | 'i00_baseline' | 'official_process_capture' | 'own_fixture';

export interface OfficialEvidenceRef {
  /** Stable id, e.g. `E-HELP-003`. Cited by every capability record. */
  readonly id: string;
  readonly layer: EvidenceLayer;
  /** Path plus the exact read-only command, or the static file searched. */
  readonly source: string;
  readonly observedAtUtc: string;
  /** The official version this observation belongs to, or null if unpinned. */
  readonly pinnedToOfficialVersion: string | null;
  /**
   * Verbatim excerpt, symbol name, or literal. Never a paraphrase.
   *
   * THIS IS A LIVE CLAIM, and its standing differs by entry. Read it with the
   * scope below, not as a blanket guarantee:
   *   AUDITED   `E-BUNDLE-021`..`027` and `E-PROBE-R3-P4`. Every recorded
   *             range was re-measured against the shipped bundle in I02-R5 and
   *             slices its excerpt exactly. Two pieces are not single slices:
   *             E-BUNDLE-025 (two ranges) and E-BUNDLE-026 (a composite third
   *             piece) — see the note on the evidence block that declares them.
   *   KNOWN-UNAUDITED  `E-BUNDLE-001`..`020` and `E-HELP-001`..`005`. These
   *             predate the offset audit and were NOT re-measured. At least
   *             two are visibly not plain slices — E-BUNDLE-001 prints
   *             `… 2189 characters … elided here …`, and E-HELP-005's field
   *             opens with the words "OBSERVATION (not a quotation …)" — so
   *             this field is already known to be polymorphic across entries.
   *             Do NOT read an unaudited excerpt as byte-for-byte, and do NOT
   *             cite one as a verbatim offset. Their conclusions may still
   *             hold; their FORM is unproven. Auditing them is outstanding
   *             work, not a finding against them.
   */
  readonly excerpt: string;
  /** Licence of the source. Unknown for every official artifact (I00 §4). */
  readonly license: 'unknown_proprietary' | 'own_fixture';
}

/** Observed 2026-09-29 by the I02 task. Re-derivable with `verify-runtime.mjs evidence`. */
export const OFFICIAL_RUNTIME_EVIDENCE_PIN: {
  readonly cliPath: string;
  readonly cliVersion: string;
  readonly helpExitCode: number;
  readonly helpStdoutBytes: number;
  readonly helpSha256: string;
  readonly observedAtUtc: string;
  readonly i00CliSha256: string;
} = {
  cliPath: 'C:/ZCode/resources/glm/zcode.cjs',
  cliVersion: '0.16.9',
  helpExitCode: 0,
  helpStdoutBytes: 3334,
  helpSha256: '792f3f9bce61a346181887daa1d8eedf01b7ba47c367f9f44a0e6b73038cf6db',
  observedAtUtc: '2026-09-29T18:55:00Z',
  i00CliSha256: 'fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f'
};

const SRC_HELP = 'C:/ZCode/resources/glm/zcode.cjs  (node <bundle> --help)';
const SRC_BUNDLE = 'C:/ZCode/resources/glm/zcode.cjs  (read-only static symbol/schema text)';
const OBS = OFFICIAL_RUNTIME_EVIDENCE_PIN.observedAtUtc;
const V = OFFICIAL_RUNTIME_EVIDENCE_PIN.cliVersion;

/** Every official citation collected by I02, in one auditable place. */
export const OFFICIAL_EVIDENCE: readonly OfficialEvidenceRef[] = [
  {
    id: 'E-HELP-001',
    layer: 'official_help_text',
    source: SRC_HELP,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'app-server Run the ZCode Protocol stdio app server',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-HELP-002',
    layer: 'official_help_text',
    source: SRC_HELP,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: '--disallowed-tools, --disallowedTools <tools...>  Remove whole tools for this prompt/TUI run only; saved settings are unchanged.',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-HELP-003',
    layer: 'official_help_text',
    source: SRC_HELP,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // REV4 m-3: the pre-review excerpt squeezed this line's four-space column
    // gap down to two, so it was not byte-for-byte. Re-typed against the help
    // output, keeping the four spaces.
    excerpt: '--mode <mode>    Permission mode for prompts: build, edit, plan, or yolo (default: yolo for --prompt)',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-HELP-004',
    layer: 'official_help_text',
    source: SRC_HELP,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: '--surface <surface>  Presentation surface for headless prompts/app-server: terminal or desktop',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-HELP-005',
    layer: 'official_help_text',
    source: SRC_HELP,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // REV4 m-2. This entry is an OBSERVATION, not a quotation, and is labelled
    // as one because the field's contract says "Verbatim excerpt, symbol name,
    // or literal. Never a paraphrase." The pre-review version put a narrative
    // in the excerpt field with no marker at all, and the review's search for
    // it in the real help text came back empty — correctly.
    //
    // WHAT WAS ACTUALLY RUN, twice, and what came back:
    //   `node <bundle> --help`          -> exit 0, 3334 bytes
    //   `node <bundle> app-server --help` -> exit 0, 3334 bytes
    // i.e. the subcommand reprints the top-level help. It is kept because it
    // tells the executor not to go looking for a per-subcommand help surface
    // that does not exist; it is cited by no capability record.
    excerpt:
      'OBSERVATION (not a quotation — no such line exists in the help text): '
      + '`node <bundle> --help` and `node <bundle> app-server --help` both exit 0 and both emit the identical 3334-byte '
      + 'top-level help; the CLI exposes no per-subcommand help surface.',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-001',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // REV4 m-1. The pre-review excerpt was NOT verbatim: it silently dropped
    // `computerUseOperationEvent` (which sits between `runtime/capabilities`
    // and `session/create`) and it inserted a space after every comma that the
    // minified bundle does not have. Both made it a paraphrase wearing a
    // quote's clothes.
    //
    // Re-typed on 2026-09-30 as TWO DISJOINT CONTIGUOUS RUNS. Each run below is
    // byte-for-byte contiguous in the bundle; the `⟪…⟫` marker states exactly
    // how much sits between them, so a reader can never mistake the join for
    // official text. Run A is the head of the map (it covers every session
    // method the allowlist and FORBIDDEN_METHODS discuss); run B is the
    // usage/stats/childProcesses cluster.
    //
    // WHAT THIS EXCERPT DOES NOT ESTABLISH, and what the REV4 I-5 fix turned on:
    // the map is a NAME table. It says these method names exist. It says nothing
    // about what any handler does, so it is not read-only evidence for any of
    // them.
    excerpt:
      'va={runtimeCapabilities:"runtime/capabilities",computerUseOperationEvent:"computer-use/operation-event",'
      + 'sessionCreate:"session/create",sessionResume:"session/resume",sessionList:"session/list",'
      + 'sessionSubagents:"session/subagents",sessionRequestRuntimePreferences:"session/requestRuntimePreferences",'
      + 'sessionRead:"session/read",sessionMessages:"session/messages",sessionEvents:"session/events",'
      + 'sessionDebug:"session/debug",sessionSubscribe:"session/subscribe",sessionSend:"session/send",'
      + 'sessionStop:"session/stop",sessionCancelBackgroundTask:"session/cancelBackgroundTask",'
      + '⟪… 2189 characters of the same minified map elided here …⟫'
      + 'usageStats:"usage/stats",sessionUsage:"session/usage",processChildProcesses:"process/childProcesses",',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-002',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'default: throw new sf(-32601, `Method not found: ${t.method}`)   // app-server request dispatch rejects unknown methods with JSON-RPC -32601',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-003',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'case va.runtimeCapabilities: return { independentPlanState: !0 }',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-004',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'requestClient(va.interactionRequestPermission, {input,reason,requestId, ...}) / interaction/requestUserInput / interaction/requestOfficialMcpAuthHeaders / interaction/browserExecute',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-005',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'm.object({method:m.literal("startup/storagePath"),...}), "startup/storagePrepared", "startup/storageState", "startup/storagePathReady"',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-006',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'this.config.disallowedTools.has(t.toolName) ? this.deny(t,a,"rule.disallowedTools",`Tool ${t.toolName} is explicitly disallowed`) : ...',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-007',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'z6s=m.object({mode:m.enum(["plan","build","edit","yolo","auto"]).optional(), allowedTools:..., disallowedTools:m.array(m.string()).optional(), ...}); PermissionDisallowedTools:"permission.disallowedTools"',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-008',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'deferred/steer input schema: {queryId, input, inputPreview, inputSize, commandKind, source, toolDisallowlist:m.array(Dn).optional(), delivery, targetTurnId, queueLength, intent}.strict()',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-009',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'gJt={offPeakTaskId,title,status:enum(queued|paused|running|completed|failed|cancelled),...}; failureStage: enum(client_validation,ticket_request,local_persist); errorCategory: enum(client_validation,eligibility_3101,quota_3103,network,invalid_response,local_persist,unknown)',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-010',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'case "quota_3103": "The idle-time task quota is used up for now. ..."  // the only quota class text found describes IDLE-TIME AUTOMATION quota, not chat billing',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-011',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'apiRetry, retryBudget, modelRetryBudget, canRetry, maxAttempts, retryAfterMs  // retry state is observable; no official key that disables retry was found',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-012',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 'CallToolRequestSchema / ListToolsRequestSchema / "tools/call" / "tools/list" appear inside the MCP SDK schema table, not inside the ZCode app-server method map `va`',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-013',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    excerpt: 't.mode==="auto" ? this.deny(t,a,"mode.auto.unimplemented","Auto mode is reserved but not implemented yet") : ...',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-014',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // VERIFIED VERBATIM by re-scan on 2026-09-30. This is the server->client
    // startup union; it establishes DIRECTION and the required params, which the
    // earlier (pre-review) version of this table had recorded as "not established".
    excerpt:
      'GUi=m.discriminatedUnion("method",[m.object({method:m.literal("startup/storagePath"),params:m.object({path:m.string().min(1).max(32768)}).strict()}).strict(),'
      + 'm.object({method:m.literal("startup/storagePrepared"),params:m.object({}).strict()}).strict(),'
      + 'm.object({method:m.literal("startup/storageState"),params:vYe}).strict()])',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-015',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // The client->server reply. `reuse` is the only optional field.
    //
    // I02-F4 ATTRIBUTION CORRECTION (coordinator-adjudicated; previously
    // recorded as concern 2 of report §12.10, and previously left uncorrected
    // for lack of authority). This schema belongs to the SEPARATE
    // `app-server --prepare-storage` mode: E-BUNDLE-026 shows the only writer of
    // the matching `startup/storagePath` is the `prepareStorageOnly` branch, and
    // E-BUNDLE-023 shows the full app-server IGNORES id-less notifications by
    // design. The literal is real and the entry stays — but it describes a
    // DIFFERENT surface, and it is no longer cited by the capability row it used
    // to justify (`zero_send_startup_handshake`), nor is the method on the write
    // allowlist.
    excerpt: 'JUi=m.object({method:m.literal("startup/storagePathReady"),reuse:m.boolean().optional()}).strict()',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-016',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // The startup/storageState params schema, read far enough to show it is a
    // local storage/migration progress report, not an account or entitlement field.
    //
    // REV4: re-typed COMPLETE on 2026-09-30. The previous excerpt cut off at
    // `elapsedMs:...`, which is exactly the part P3 needs in order to be
    // machine-evaluated, so the truncation has been removed. Note the phase
    // enum has SIX members, not seven — the old report text said "七值枚举".
    // The two literal constraints the P3 step asserts on are visible verbatim
    // here: `schemaVersion:m.literal(1)` and both `m.enum([...])` lists.
    excerpt:
      'vYe=m.object({schemaVersion:m.literal(1),attemptId:m.string().min(1).max(128),sequence:m.number().int().positive(),'
      + 'databaseId:m.string().min(1).max(128),databaseKind:m.enum(["session","tasks-index"]),'
      + 'phase:m.enum(["checking","waiting_for_lock","migrating","committing","ready","failed"]),'
      + 'migration:vAe.optional(),elapsedMs:m.number().nonnegative().finite(),'
      + 'completed:m.number().int().nonnegative().optional(),total:m.number().int().nonnegative().optional(),'
      + 'errorCode:bAe.optional(),...gZe.shape})',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-017',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // I02-F4 ATTRIBUTION CORRECTION — the comment this entry used to carry was
    // WRONG and has been replaced, not deleted. The previous comment asserted
    // "the app-server is an MCP server: the transport is Model Context Protocol,
    // with a negotiated protocol version", and a capability row built a
    // protocol-version-negotiation verdict on it. It is not this surface.
    //
    // WHAT THIS TEXT ACTUALLY IS (report §12.1.1, re-read verbatim at character
    // offsets 4329547 / 4330312 / 4444791): the version table `Nct` and
    // `cge="2025-11-25"` sit in the bundle's own VENDORED MCP TypeScript SDK,
    // next to a cluster of `io.modelcontextprotocol/protocolVersion` constants,
    // and the same SDK writes its own frames with `jsonrpc:"2.0"` — a member the
    // ZCode Protocol schemas do not even declare (E-BUNDLE-021). The app-server's
    // own `-32022`, at offset 14668202, is `Client request timed out: ${t}`.
    //
    // The excerpt is unchanged because the LITERALS are unchanged and still true.
    // What changed is the surface they belong to, and the capability row that
    // cited them (`protocol_version_negotiation`) has been re-derived from
    // E-BUNDLE-021/023/027 instead. This entry is now cited by nothing; it is
    // kept, and never deleted, so the record of the wrong inference survives.
    excerpt:
      'cge="2025-11-25",Nct=[cge,"2025-06-18","2025-03-26","2024-11-05","2024-10-07"] ... '
      + 'this._supportedProtocolVersions=e?.supportedProtocolVersions??Nct; '
      + 'this.setNotificationHandler("notifications/cancelled",t=>{this._oncancel(t)})',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-018',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // `HUi` is the table of methods the SERVER registers on the CLIENT. It is the
    // proof that browserList/browserExecute are reverse requests, not outbound
    // control methods: the pre-review allowlist wrongly listed browserList as one.
    excerpt:
      'HUi={[va.workspaceHookTrustGrant]:{params:qee,result:efe},[va.mcpList]:{params:kYe,result:Xpe},'
      + '[va.interactionBrowserList]:{params:Gsr,result:IYe},[va.interactionBrowserExecute]:{params:Jsr,result:tfe}}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-019',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // The official frame bound. Our 2 MiB product limit sits INSIDE this, so the
    // product is the tighter constraint and no official limit is being exceeded.
    excerpt:
      'if(e.length<4||e.length>QI.maxPhysicalFrameBytes)return!1 ... '
      + 'if(o>n)return{kind:"fault",fault:{reasonCode:"remote.rpcFrame.envelopeTooLarge",terminal:!0}}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-020',
    layer: 'official_static_bundle',
    source: SRC_BUNDLE,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // Methods that exist in the official map and are DELIBERATELY never sent by
    // this product. Recorded so that adding any of them to the write allowlist
    // is a visible, citable act rather than an accident.
    excerpt:
      'providerUpdateAccountConfig:"provider/updateAccountConfig", '
      + 'providerTestModelConnectivity:"provider/testModelConnectivity", '
      + 'workspaceGenerateText:"workspace/generateText", '
      + 'sessionSend:"session/send", offPeakCreate:"offPeak/create", automationCreate:"automation/create"',
    license: 'unknown_proprietary'
  },
  /* ------------------------------------------------------------------ *
   * I02-F3-2. The official client's / official server's ACTUAL wire
   * contract, read out of the shipped bundle. These seven entries are the
   * forensic result the coordinator asked for, and they change what the
   * probe is allowed to WRITE (not what the matrix says — see the report).
   * Every excerpt below was produced by a byte-offset slice of
   * C:/ZCode/resources/glm/zcode.cjs and re-printed with JSON.stringify, so
   * the text is byte-for-byte, escapes included.
   *
   * TWO EXCEPTIONS, so the sentence above is not read as stronger than it is
   * (REV9 §5, after I02-R5 re-measured every recorded offset in 021..027):
   *   E-BUNDLE-025 — both pieces ARE verbatim, but they are NOT one slice.
   *   They sit in two separate recorded ranges (14128970..14129166 and
   *   14128587..14128737), the second EARLIER in the file than the first.
   *   E-BUNDLE-026 — the third piece is a COMPOSITE: the symbol name
   *   `runZCodeProtocolCommand` (literal at 14803800) is glued in front of the
   *   call it labels (14803411..14803630), 389 characters away. That piece is
   *   the one place here whose text cannot be produced by slicing alone.
   * Every recorded range in 021..027 now slices its excerpt exactly. That was
   * verified against the bundle, not assumed.
   * ------------------------------------------------------------------ */
  {
    id: 'E-BUNDLE-021',
    layer: 'official_static_bundle',
    source: `${SRC_BUNDLE} [char offsets 735526..735906]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // THE WHOLE MESSAGE CONTRACT, in one contiguous run. This is the single
    // most load-bearing excerpt in this file and it was missing for four
    // rounds: every frame this product has ever written carried a `jsonrpc`
    // member, and NONE of the four official message schemas declares one.
    // All four are `.strict()`, so `jsonrpc` is an unrecognised key.
    //   qir = request   {id, method, params?, trace?}   strict
    //   Wir = notif.    {method, params?, trace?}        strict
    //   Vir = success   {id, result}                     strict
    //   Hir = error     {id, error:{code,message,data?}} strict
    //   qHt = the union of exactly those four.
    // `Dn` is `Dn=m.string().trim().min(1)` (offset 731352) and
    // `yYe=m.union([m.string(),m.number().int()])` — a request id may be a
    // string OR a non-negative-safe int, never null.
    excerpt:
      'qir=m.object({id:yYe,method:Dn,params:m.unknown().optional(),trace:$Ht.optional()}).strict(),'
      + 'Wir=m.object({method:Dn,params:m.unknown().optional(),trace:$Ht.optional()}).strict(),'
      + 'Vir=m.object({id:yYe,result:m.unknown()}).strict(),'
      + 'Hir=m.object({id:yYe,error:m.object({code:m.number().int(),message:Dn,data:m.unknown().optional()}).strict()}).strict(),'
      + 'qHt=m.union([qir,Wir,Vir,Hir])',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-022',
    layer: 'official_static_bundle',
    source: `${SRC_BUNDLE} [char offsets 14672825..14672977 and 14673520..14673589]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // WHY A WHOLE MESSAGE GETS REJECTED, and — the answer to the coordinator's
    // 15-character-id question — what id such a rejection carries.
    //
    // `decodeLine` runs `qHt.safeParse` over EVERY inbound line. On failure it
    // calls `sendError(reason, code, message, data)`, and `sendError` writes
    // `{error:{code,data,message}, id:<reason>}` — the `id` slot is the
    // REASON LITERAL, not the id of the frame that was rejected. There are
    // exactly two such literals in the whole 14.8 MB bundle:
    //   "parse-error"    (11 chars)  -32700 "Parse error"                        no data
    //   "invalid-message"(15 chars) -32600 "Invalid ZCode Protocol message" (30 chars) data={issues}
    // The P4 capture recorded idStringLength 15 and error.message length 30 with
    // data = {issues:[ … ]}, array length 1. "invalid-message" is unique in the
    // bundle, so that half of the old note stands. THE OTHER HALF DID NOT, and
    // is corrected here (REV8 A4): "parse-error" occurs FIVE times, not once.
    // Four of them are the HTML string `<span class="parse-error">` inside a
    // vendored address-parsing library (offsets 2231128 / 2231196 / 2236345 /
    // 2236515, beside AddressError / RE_BAD_CHARACTERS / RE_BAD_ADDRESS), and
    // only the fifth, at 14672784, is a real id literal. The neighbouring error
    // codes are not unique either and must never be quoted as if they were:
    // -32600 occurs 3 times (4409943, 14666961, 14672906), -32700 twice
    // (4409903, 14672798).
    //
    // So here is the claim that IS defensible, stated from a fresh full-bundle
    // scan rather than inherited. `sendError` has exactly ONE definition
    // (14673520) and exactly TWO call sites that pass a quoted bare literal as
    // the id (REV8 suggested "one"; measured, it is two — the two literals
    // named above, 104 characters apart, both in the same `decodeLine`):
    //   14672774  this.sendError("parse-error",-32700,"Parse error"),null}
    //   14672878  this.sendError("invalid-message",-32600,"Invalid ZCode …")
    // one after a JSON parse failure, one after a schema parse failure. No
    // other error-frame writer produces a string id. Both conclusions the P4
    // capture rests on are therefore untouched: the captured frame IS one of
    // these two, and it is the "invalid-message" one, because that literal
    // alone occurs once in the bundle. A frame carrying id "invalid-message"
    // can never be correlated to anything — it is a fixed diagnostic token.
    excerpt:
      'let o=qHt.safeParse(n);return o.success?o.data:(this.sendError("invalid-message",-32600,'
      + '"Invalid ZCode Protocol message",{issues:o.error.issues}),null)} '
      + '… sendError(t,n,o,s){this.send({error:{code:n,data:s,message:o},id:t})}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-023',
    layer: 'official_static_bundle',
    source: `${SRC_BUNDLE} [char offsets 14657669..14658095]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // WHAT THE SERVER DOES WITH EACH INBOUND FRAME KIND. Two facts fall out of
    // this and both matter for P4:
    //   1. A frame with `id` AND `method` is a REQUEST and is answered.
    //   2. A frame with `method` and NO `id` is a NOTIFICATION and is
    //      EXPLICITLY IGNORED — the server logs
    //      "ZCode Protocol notification ignored" and moves on. It does not even
    //      produce a rejection.
    // Consequence: the `startup/storagePathReady` notification P4 has been
    // writing is inert on the app-server surface BY DESIGN. It can be neither
    // the cause of the failure nor its cure.
    excerpt:
      'async handleMessage(t){if(this.runtimeResources.assertServing(),GHo(t)){this.resolveClientRequest(t.id,t.result);return}'
      + 'if(JHo(t)){this.rejectClientRequest(t.id,new sf(t.error.code,t.error.message,t.error.data));return}'
      + 'if(VHo(t))return await this.handleRequest(t);'
      + 'HHo(t)&&this.logger?.debug("ZCode Protocol notification ignored",'
      + '{event:"zcode_protocol.notification.ignored",method:t.method,module:"bootstrap.zcode_protocol"})}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-024',
    layer: 'official_static_bundle',
    source: `${SRC_BUNDLE} [char offset 14667568]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // THE OFFICIAL RESPONSE SHAPE. `{id, result}` / `{error, id}` and NOTHING
    // else — no `jsonrpc` member on a response either. This is why the captured
    // error frame's top-level keys were exactly ["error","id"] and why our own
    // refusal frame, which also carried `jsonrpc`, was equally malformed.
    excerpt: 'ok(t,n){return{id:t,result:n}}fail(t,n,o,s){return{error:{code:n,data:s,message:o},id:t}}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-025',
    layer: 'official_static_bundle',
    // NOT CONTIGUOUS, and the recorded offsets say so: the `startup/storagePath`
    // write and its two follow-ups sit at 14128970..14129166, while the
    // readline acknowledgement handler quoted second sits EARLIER in the file at
    // 14128587..14128737. REV8 A4 found the old single offset (14128310) wrong
    // by 660 against the first span; a re-measure shows the entry needed two
    // offsets, not one.
    source: `${SRC_BUNDLE} [char offsets 14128970..14129166 and 14128587..14128737]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // THE OFFICIAL storagePathReady TIMING, verbatim. `jHo` is
    // `prepareProtocolStartupStorage`. It writes `startup/storagePath` FIRST,
    // then blocks on a readline over the peer's input for ONE line, parses it
    // with `JUi` (E-BUNDLE-015) and resolves `T.reuse ?? !1`; a 30 000 ms timer
    // rejects with kind "startup_status_timeout" and a line longer than 1024
    // characters is refused as "Invalid storage acknowledgement". Only when
    // reuse is not true does it open the storage (emitting storageState) and
    // finally write `startup/storagePrepared`.
    excerpt:
      'await g({method:"startup/storagePath",params:{path:e.dbPath}});let _=await l;clearTimeout(a),s.close(),'
      + '_||(u=await lPn(e),u.close(),u=void 0),await g({method:"startup/storagePrepared",params:{}})} '
      + '… s.once("line",w=>{try{if(w.length>1024)throw new Error("Invalid storage acknowledgement");'
      + 'let T=n.parse(JSON.parse(w));_(T.reuse??!1)}catch(T){b(T)}})',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-026',
    layer: 'official_static_bundle',
    // The third piece is NOT one verbatim slice, and the header's "every excerpt
    // is a byte-offset slice" claim does not hold for it: it glues a symbol
    // name to a call that sits 389 characters later in the file. Measured:
    // `runZCodeProtocolCommand` the literal is at 14803800, and the quoted
    // `return await(…)` call it labels runs 14803411..14803630. Recorded here
    // rather than silently smoothed over, because a reader slicing 14803411 and
    // not finding `runZCodeProtocolCommand` would otherwise conclude the
    // excerpt is fabricated.
    source: `${SRC_BUNDLE} [char offsets 498346..498380, 14678298..14678446, and 14803411..14803630 (the third piece also names the symbol runZCodeProtocolCommand, literal at 14803800)]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // WHICH PROCESS MODE OWNS THAT HANDSHAKE. `zcode app-server` takes a
    // `--prepare-storage` flag, forwards it as `prepareStorageOnly`, and
    // `runZCodeProtocolAgent` branches on it: the storage-preparation branch
    // calls `jHo` and RETURNS (E-BUNDLE-025's timing), while the FULL
    // app-server branch calls `lPn` directly — open the storage, stream
    // `startup/storageState`, no `startup/storagePath`, no wait for
    // `storagePathReady`, no `startup/storagePrepared`.
    // This is exactly the surface the P1-P4 probe spawns, and exactly what the
    // real capture shows: five `startup/storageState` frames and nothing else.
    excerpt:
      '"prepare-storage":{type:"boolean"} … '
      + 'if(e.prepareStorageOnly){let B=K0({env:e.env});'
      + 'await jHo({dbPath:jie(B,e.cwd),input:e.input??process.stdin,output:e.output??process.stdout});return} '
      + '… runZCodeProtocolCommand: return await(n.runZCodeProtocolAgent??(await Qg()).runZCodeProtocolAgent)'
      + '({lifecycle:n.protocolLifecycle,cwd:l,env:a,input:n.protocolInput??e.stdin,output:e.stdout,'
      + 'presentationSurface:o,prepareStorageOnly:s,version:S9})',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-BUNDLE-027',
    layer: 'official_static_bundle',
    source: `${SRC_BUNDLE} [char offsets 784216..787471, 3255 characters, contiguous]`,
    observedAtUtc: OBS,
    pinnedToOfficialVersion: V,
    // The COMPLETE official server method map `va`, contiguous, untruncated.
    // It is the negative evidence for the coordinator's "is there an initialize
    // / a version negotiation?" question: there is no `initialize`, no
    // `protocol/version`, no `initialized`, no handshake method of any kind in
    // the 3255-character map. The ZCode Protocol surface has no first frame
    // requirement at all, which is why the real capture is five unsolicited
    // startup frames with zero frames sent.
    //
    // CORRECTED (REV8 A4), and the correction is about the handle, not the
    // finding. The old offsets 784241..787495 (3254 chars) cut 25 characters
    // into the table and ran 24 past its end, so slicing them yields text that
    // is NOT the excerpt below. The real span is 784216..787471. The method
    // count was wrong too: 74 key:"value" pairs, with 74 distinct keys and 74
    // distinct values, not 69 — 74 is also the total number of quoted strings
    // in the table, so no pair is hidden behind a duplicate. The CONCLUSION is
    // unchanged, and was re-verified against the corrected span: of those 74
    // keys and 74 values, `/init|version|handshake|negoti|protocol/i` matches
    // ZERO.
    //
    // CORRECTION TO E-BUNDLE-017, which must not be silently dropped: `Nct` /
    // `cge="2025-11-25"` and the `-32022` quoted there are the VENDORED MCP SDK
    // (`io.modelcontextprotocol/*` constants, offsets ~4329547-4330329 and
    // 4410253), not the ZCode Protocol app-server. The app-server's own -32022
    // is `Client request timed out: ${t}` (offset 14668202, not the 14668247
    // previously recorded). The MCP version table is therefore evidence about
    // a DIFFERENT surface and must not be used to justify a first-frame
    // negotiation on this one.
    excerpt:
      'va={runtimeCapabilities:"runtime/capabilities",computerUseOperationEvent:"computer-use/operation-event",'
      + 'sessionCreate:"session/create",sessionResume:"session/resume",sessionList:"session/list",'
      + 'sessionSubagents:"session/subagents",sessionRequestRuntimePreferences:"session/requestRuntimePreferences",'
      + 'sessionRead:"session/read",sessionMessages:"session/messages",sessionEvents:"session/events",'
      + 'sessionDebug:"session/debug",sessionSubscribe:"session/subscribe",sessionSend:"session/send",'
      + 'sessionStop:"session/stop",sessionCancelBackgroundTask:"session/cancelBackgroundTask",'
      + 'sessionFork:"session/fork",sessionCompact:"session/compact",sessionGoal:"session/goal",'
      + 'sessionClose:"session/close",sessionSetModel:"session/setModel",sessionSetThoughtLevel:"session/setThoughtLevel",'
      + 'sessionSetMode:"session/setMode",workspaceReadPresentation:"workspace/readPresentation",'
      + 'workspaceHookTrustGrant:"workspace/hooks/trustGrant",providerUpdateAccountConfig:"provider/updateAccountConfig",'
      + 'workspaceUpdateInteractionPreferences:"workspace/updateInteractionPreferences",'
      + 'workspaceUpdateModelIoPreferences:"workspace/updateModelIoPreferences",'
      + 'workspaceUpdateOffPeakToolPolicy:"workspace/updateOffPeakToolPolicy",'
      + 'workspaceUpdateDynamicWorkflowPolicy:"workspace/updateDynamicWorkflowPolicy",'
      + 'workspaceGenerateText:"workspace/generateText",workspaceCancelGenerateText:"workspace/cancelGenerateText",'
      + 'providerTestModelConnectivity:"provider/testModelConnectivity",mcpList:"mcp/list",pluginsList:"plugins/list",'
      + 'pluginsReferenceCatalog:"plugins/referenceCatalog",pluginsReferenceCatalogWithCategory:"plugins/referenceCatalogWithCategory",'
      + 'skillsReferenceCatalog:"skills/referenceCatalog",workflowsList:"workflows/list",workflowsGet:"workflows/get",'
      + 'workflowsUpdateMeta:"workflows/updateMeta",workflowsDelete:"workflows/delete",workflowsRuns:"workflows/runs",'
      + 'workflowsMove:"workflows/move",pluginsResolveSuggestedReference:"plugins/resolveSuggestedReference",'
      + 'pluginsSetEnabled:"plugins/setEnabled",pluginsOverview:"plugins/overview",'
      + 'pluginsMarketplaceAdd:"plugins/marketplace/add",pluginsMarketplaceRemove:"plugins/marketplace/remove",'
      + 'pluginsMarketplaceUpdate:"plugins/marketplace/update",pluginsInstall:"plugins/install",'
      + 'pluginsCancelOperation:"plugins/cancelOperation",pluginsUninstall:"plugins/uninstall",'
      + 'pluginsUpdate:"plugins/update",pluginsRestoreBuiltin:"plugins/restoreBuiltin",'
      + 'pluginsConfigure:"plugins/configure",pluginsResetConfig:"plugins/resetConfig",'
      + 'pluginsValidate:"plugins/validate",pluginsDescribe:"plugins/describe",automationCreate:"automation/create",'
      + 'automationUpdate:"automation/update",automationCheckTaskBinding:"automation/checkTaskBinding",'
      + 'automationList:"automation/list",automationDelete:"automation/delete",offPeakCreate:"offPeak/create",'
      + 'offPeakList:"offPeak/list",usageStats:"usage/stats",sessionUsage:"session/usage",'
      + 'processChildProcesses:"process/childProcesses",interactionRequestPermission:"interaction/requestPermission",'
      + 'interactionRequestUserInput:"interaction/requestUserInput",'
      + 'interactionRequestProviderRuntimeHeaders:"interaction/requestProviderRuntimeHeaders",'
      + 'interactionRequestOfficialMcpAuthHeaders:"interaction/requestOfficialMcpAuthHeaders",'
      + 'interactionBrowserList:"interaction/browserList",interactionBrowserExecute:"interaction/browserExecute"}',
    license: 'unknown_proprietary'
  },
  {
    // I02-F4. The FIRST evidence in this table that is an observation of a
    // running official process rather than a reading of its source.
    //
    // Provenance, precisely: the COORDINATOR ran P1-P4 twice against the real
    // `zcode app-server` (round 2 and round 3) and reviewed the resulting JSON.
    // This task did not run them, did not start the process, and did not touch
    // the file. Round 3 is the one that closes the round-2 blocker; round 2 is
    // cited alongside it because the two runs differ in exactly one frame shape
    // and the difference is the proof.
    //
    // What it shows, verbatim from `observation.startupSequence` and
    // `observation.frameLog`: five unsolicited `startup/storageState`
    // notifications — checking, checking, checking, committing, ready — every
    // one of them classified `kind:"notification"` with `hasId:false`, arriving
    // while the client had written NOTHING. Round 2's capture of the same five
    // frames is identical in sequence; its run failed only at P4, where the
    // request frame carried a `jsonrpc` member and was rejected whole
    // (E-BUNDLE-021/022).
    id: 'E-PROBE-R3-P4',
    layer: 'official_process_capture',
    // IN-REPO, HASHED (REV8 §7). This entry used to point at
    // `.superpowers/sdd/929/review-artifacts/929/probe-r3-p4.json`, a path in a
    // DIFFERENT checkout that a reader of this repository cannot open. It is
    // now the one cited capture every reader of this repo can reach, sitting
    // beside E-I00-001's in-repo `baseline.json` — same rule, same tree. The
    // SHA is written into the pointer on purpose: two copies will drift the
    // moment anyone re-runs P4, and a hash makes that drift visible instead of
    // silent. The zcode-dev original stays authoritative; if the two ever
    // disagree, the hash mismatch is the alarm and this file must not be
    // silently re-pointed.
    source: 'review-artifacts/929/probe-r3-p4.json [sha256 81c062492821c2810855d733e87821d198ecf517566f95609c5aff4f9fc3f39b] (in-repo copy of the coordinator-run real app-server capture, read-only afterwards; authoritative original: zcode-dev/.superpowers/sdd/929/review-artifacts/929/probe-r3-p4.json, same sha256; round 2 sibling: probe-r2-p4.json; sidecar provenance: review-artifacts/929/probe-r3-p4.provenance.json)',
    observedAtUtc: '2026-09-30T04:00:00Z',
    pinnedToOfficialVersion: V,
    // ONE SCOPE CAVEAT, stated here because the excerpt invites a misreading
    // (REV8 §3 item 7). This capture is an F3 BUILD, so the whole run wrote 2
    // control frames, not 0 — the excerpt honestly reports `controlFrames:2`.
    // "Zero frames" is true of the ARRIVAL MOMENT and nothing more: the reply
    // was written after the 5th (ready) frame, which the capture records as
    // `observation.startupReply.triggerFrameIndex = 5`. F4 removed that reply,
    // so a re-run on the shipped build must show `controlFrames:1`. A re-run
    // showing 2 means the reply came back; one showing 0 means something else
    // was removed. Neither is what this row claims.
    excerpt:
      'startupSequence: [1 checking, 2 checking, 3 checking, 4 committing, 5 ready] '
      + '— every methodName "startup/storageState", every phaseIsOfficialEnumMember true; '
      + 'frameLog: 1..5 all kind:"notification" hasId:false correlatedToRequest:false, '
      + '6 kind:"response" idType:"string" idStringLength:2 correlatedToRequest:true '
      + 'evaluatedAgainstMethod:"runtime/capabilities"; '
      + 'ledger {modelDispatch:0, modelDispatchAttempts:0, controlFrames:2, refusalFrames:0, refusedReverse:0}; '
      + 'childReclaim {stage:"stdin-eof", pendingWaiters:0}',
    license: 'unknown_proprietary'
  },
  {
    id: 'E-I00-001',
    layer: 'i00_baseline',
    source: 'review-artifacts/929/baseline.json (I00, read-only)',
    observedAtUtc: '2026-09-29T06:24:35Z',
    pinnedToOfficialVersion: V,
    excerpt: 'cliSha256 fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f; asarSha256 172d6f33...; runningHostVersion NOT_VERIFIED; appServerParityOfCliHelp NOT_VERIFIED',
    license: 'unknown_proprietary'
  }
];

const byId = new Map<string, OfficialEvidenceRef>(OFFICIAL_EVIDENCE.map((e) => [e.id, e]));

/** @param ids evidence ids cited by a capability record */
function cite(...ids: readonly string[]): readonly OfficialEvidenceRef[] {
  return ids.map((id) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`capability-probe: unknown evidence id referenced: ${id}`);
    return found;
  });
}

/* ================================================================== *
 * 2. The capability matrix
 * ================================================================== */

export type CapabilityId =
  | 'canonical_runtime_identity'
  | 'cli_version_and_hash'
  | 'live_host_version'
  | 'stdio_app_server_support'
  | 'zero_send_startup_handshake'
  | 'protocol_version_negotiation'
  | 'unknown_method_rejection'
  | 'account_ready'
  | 'account_entitlement_readback'
  | 'account_config_write_never_used'
  | 'catalog_model_readback'
  | 'billing_class_evidence'
  | 'quota_source'
  | 'native_tool_disable_scope'
  | 'mcp_tool_disable_scope'
  | 'automation_task_disable_scope'
  | 'permission_mode_is_not_tool_disable'
  | 'retry_disable'
  | 'terminal_state_correlation'
  | 'precise_cancel'
  | 'role_fidelity'
  | 'own_session_resume'
  | 'external_tools_continuation';

/**
 * `unknown`            no official source establishes it; the product treats the
 *                      capability as absent.
 * `mechanism_verified` the mechanism is named by an official source, readable
 *                      back without sending, and (for safety-bearing items) its
 *                      control surface is complete enough to gate on.
 * `behavior_verified`  requires an OBSERVED REAL RUN by a human-reviewed capture
 *                      of the official process — never a fixture, and never a
 *                      consequence of running the probe. As of I02-F4 exactly one
 *                      row holds it (`zero_send_startup_handshake`, on
 *                      E-PROBE-R3-P4); a fixture alone can never move a row
 *                      here, and the capture must be cited as
 *                      `official_process_capture` evidence or the row is wrong.
 *                      NARROWED (REV8 §4): a capture may raise an OBSERVATION
 *                      row only. It may NEVER move a `blocking: true` action
 *                      row off the blocking list — those need a product
 *                      behaviour acceptance — and it may never turn `blocked`
 *                      into this state, nor support `mechanism_verified`. The
 *                      four clauses are executable: `behaviourClaimRefusal`.
 * `blocked`            a control surface is missing or out of scope, so the
 *                      product must refuse the action outright.
 */
export type CapabilityState = 'unknown' | 'mechanism_verified' | 'behavior_verified' | 'blocked';

/** Mirrors the UI01 evidence ladder in apps/ui/src/data/snapshot.ts. */
export type EvidenceGrade = 'E0' | 'E1' | 'E2' | 'E3';

export interface CapabilityRecord {
  readonly id: CapabilityId;
  readonly title: string;
  readonly state: CapabilityState;
  readonly grade: EvidenceGrade;
  /** true = the product must refuse the corresponding action. */
  readonly blocking: boolean;
  /** Which UI01 field/column this record is meant to feed. */
  readonly uiTarget: string | null;
  readonly evidence: readonly OfficialEvidenceRef[];
  readonly reason: string;
  /** What would have to be observed to move this off unknown/blocked. */
  readonly nextEvidence: string;
}

/**
 * The authoritative I02 verdict table.
 *
 * Nothing here is inferred from the fixture. The fixture proved that the
 * transport, the limits and the refusal path work; it proved nothing about the
 * official runtime, and no record below is upgraded because of it.
 */
export const CAPABILITY_MATRIX: readonly CapabilityRecord[] = [
  {
    id: 'canonical_runtime_identity',
    title: '合法官方路径与真实 canonical 身份（非不明 shim）',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '版本与指纹 / 官方包 SHA-256',
    evidence: cite('E-I00-001', 'E-BUNDLE-001'),
    reason:
      'The spawn target is a real regular file at C:/ZCode/resources/glm/zcode.cjs; realpath resolves inside the declared install root, the leading bytes are not an MZ launcher, and the streamed SHA-256 equals the I00 baseline. Discovery measures identity, it does not assume it from the path.',
    nextEvidence: 'Re-run `verify-runtime.mjs discovery --hash cli`; any drift flips this to blocked.'
  },
  {
    id: 'cli_version_and_hash',
    title: 'CLI 版本与 hash 读回',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '版本与指纹 / 官方 CLI 运行时版本',
    evidence: cite('E-I00-001'),
    reason:
      '`node <bundle> --version` exits 0 and prints 0.16.9; the version therefore comes from the file that would be executed, not from the installation. The help surface pins to the same build (sha256 792f3f9b…, 3334 bytes).',
    nextEvidence: 'Keep re-pinning. Help-derived claims are only valid for this exact help hash.'
  },
  {
    id: 'live_host_version',
    title: '存活宿主（正在运行的官方进程）版本',
    state: 'unknown',
    grade: 'E0',
    blocking: false,
    uiTarget: '版本与指纹 / 官方桌面宿主版本',
    evidence: cite('E-I00-001'),
    reason:
      'I02 does not start, stop, attach to, query or enumerate any official process. A running-process version is a property of a process; the installed 3.14.4 ASAR version must never be substituted for it. I00 recorded NOT_VERIFIED and this task does not change that.',
    nextEvidence: 'A human-supplied, read-only version readback from the running host, performed outside this product.'
  },
  {
    id: 'stdio_app_server_support',
    title: 'stdio app-server 支持',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '连接状态 / 协议版本',
    evidence: cite('E-HELP-001', 'E-HELP-004', 'E-BUNDLE-001'),
    reason:
      'The current help names `app-server  Run the ZCode Protocol stdio app server` and `--surface` explicitly lists app-server as a supported invocation. The shipped bundle carries a real request dispatch switch over the method map, with JSON-RPC error codes. Support for the transport is established; the frame schema is NOT.',
    nextEvidence: 'A zero-send handshake against the real app-server (coordinator-run, quota required).'
  },
  {
    id: 'zero_send_startup_handshake',
    title: '零发送启动通告（startup/storage*，服务端单向）',
    // I02-F4 RE-DERIVED, from mechanism_verified to behavior_verified. The
    // three facts the new state rests on, each from a different kind of source:
    //
    //   1. E-BUNDLE-014/016 (static): the server->client startup union and the
    //      six-member phase enum are exactly as this row always described them.
    //   2. E-BUNDLE-023/026 (static): there is NO client half on this surface.
    //      The `storagePath` -> `storagePathReady(reuse)` -> `storageState` ->
    //      `storagePrepared` exchange lives in the separate
    //      `app-server --prepare-storage` mode, and the app-server's inbound
    //      handler drops id-less notifications by design. E-BUNDLE-015, which
    //      this row used to cite for a "client answers with a strict object" half
    //      that does not exist here, has been struck from the citation set.
    //   3. E-PROBE-R3-P4 (observed, coordinator-run): the whole sequence really
    //      does arrive on its own — five `startup/storageState` notifications
    //      ending in `ready`, every one of them with no id, with the client
    //      having written NOTHING. A mechanism named by a source is not a
    //      behaviour; this row now cites a run.
    //
    // `blocking` went true -> false for one reason, and it is not optimism: the
    // previous block was explicitly CONDITIONAL ("the product still refuses to
    // rely on it until a coordinator-run zero-send capture is reviewed"), the
    // capture has been run and reviewed, and what it shows is that there is
    // nothing left to send. Refusing to rely on a mechanism the runtime performs
    // entirely on its own would be refusing a heartbeat, not a risk. The refusal
    // that DOES survive is structural and permanent: the client half is not on
    // the allowlist and `startup/storagePathReady` now classifies as
    // dispatching, so it cannot be written at all (see CONTROL_PLANE_METHODS).
    state: 'behavior_verified',
    // E0 STAYS E0. The grade is the UI01 SEND-GATE ladder (E1 = entitlement and
    // catalogue evidence, E2 = a real request, E3 = consumption observed), not a
    // behaviour-confidence ladder. Confirming that the runtime announces its own
    // storage state establishes no entitlement and no usage — see the same
    // rule applied to `permission_mode_is_not_tool_disable`.
    grade: 'E0',
    blocking: false,
    uiTarget: '连接状态 / 最近心跳',
    evidence: cite('E-BUNDLE-014', 'E-BUNDLE-016', 'E-BUNDLE-023', 'E-BUNDLE-026', 'E-PROBE-R3-P4'),
    reason:
      'BEHAVIOUR OBSERVED, NOT INFERRED. The official app-server performs this handshake entirely by itself. E-PROBE-R3-P4 is a coordinator-run capture of the real process: five unsolicited startup/storageState notifications (phase checking, checking, checking, committing, ready — every value a member of the E-BUNDLE-016 enum), all classified as id-less notifications, arriving while this product had written zero frames; the run then ended by closing its own stdin, and the child exited 0. E-BUNDLE-014 and E-BUNDLE-016 still name the schema and the phase enum verbatim. What was REMOVED from this row in I02-F4 is the client half: E-BUNDLE-026 shows the storagePath -> storagePathReady(reuse) -> storageState -> storagePrepared exchange belongs to the separate `zcode app-server --prepare-storage` mode, and E-BUNDLE-023 shows the app-server logs "ZCode Protocol notification ignored" for any frame with a method and no id. There is therefore nothing for a client to answer on this surface, and the product writes nothing.',
    nextEvidence:
      'Re-run the zero-send capture after any official version change; this row is pinned to 0.16.9 (E-PROBE-R3-P4) and to the schema of E-BUNDLE-014/016. A NEW client-to-server startup frame on the full app-server surface would reopen it — and would have to be re-derived, not inherited from this row.'
  },
  {
    id: 'protocol_version_negotiation',
    title: '协议版本协商（app-server 表面不存在，MCP SDK 常量不属此表面）',
    // I02-F4 RE-DERIVED, from mechanism_verified to unknown. The old row read:
    // "The app-server is an MCP server ... declares five supported protocol
    // versions ... refuses a mismatching one with JSON-RPC -32022
    // UnsupportedProtocolVersion". Every clause of that is now known to be
    // about a DIFFERENT surface, and the row's own `blocking: false` was the
    // tell that it had been doing no work: a mechanism_verified state on a
    // capability the product never acts on is decoration.
    //
    // THE DERIVATION, on this module's own state ladder:
    //   mechanism_verified  rejected — it asserts a mechanism EXISTS. It does
    //                        not. Naming an absent thing as verified is the
    //                        exact failure the admission rule above forbids.
    //   blocked             rejected — "a control surface is missing or out of
    //                        scope, so the product must refuse an action
    //                        outright". There is no action: nothing is sent,
    //                        nothing is sent wrongly, and there is no code path
    //                        that could send a version. Blocking would describe
    //                        a refusal the product is not making.
    //   behavior_verified   rejected — nothing was observed that involves a
    //                        version, and E-PROBE-R3-P4 shows the opposite:
    //                        the first six frames exchanged carry no version
    //                        field at all.
    //   unknown             CHOSEN, and it is the fail-closed direction: by this
    //                        module's definition "no official source
    //                        establishes it; the product treats the capability
    //                        as absent", which is the operative outcome here.
    //                        What the sources go on to establish — far more
    //                        than absence — is stated in `reason`, so no reader
    //                        is left with the impression that it is merely
    //                        unlooked-at.
    //
    // THE ID IS DELIBERATELY UNCHANGED. The row keeps `protocol_version_
    // negotiation` so the 23-row count, the UI01 `连接状态 / 协议版本` target
    // and every stored reference stay valid; only the title and the verdict
    // moved. Renaming the id would have been a silent break of the UI mapping
    // for no gain.
    state: 'unknown',
    grade: 'E0',
    blocking: false,
    uiTarget: '连接状态 / 协议版本',
    evidence: cite('E-BUNDLE-027', 'E-BUNDLE-021', 'E-BUNDLE-023'),
    reason:
      'THERE IS NO VERSION NEGOTIATION ON THIS SURFACE, and the surface is not MCP. E-BUNDLE-027 is the complete, untruncated official method map `va` — 74 methods, read end to end — and it contains no initialize, no protocol/version, no initialized and no handshake method of any kind. E-BUNDLE-021 is the complete inbound frame contract: a request is {id, method, params?, trace?} and a notification is {method, params?, trace?}, both .strict(), with no version field, no protocol member and no `jsonrpc` member. E-BUNDLE-023 is the server\'s own inbound gate: assertServing() plus four shape guards and a dispatch switch, with no version comparison anywhere on the path. The version table and the -32022 that the previous row cited (E-BUNDLE-017) belong to the bundle\'s vendored MCP TypeScript SDK, whose own frames carry jsonrpc:"2.0" — a member the ZCode Protocol schemas reject outright; the app-server\'s own -32022 is "Client request timed out". The observed run agrees: nothing is sent before the answer arrives, and no frame in the exchange carries a version.',
    nextEvidence:
      'This row is CLOSED unless the official surface changes. The only evidence that could reopen it is a new official method that negotiates or reports a protocol version, or a frame member the schemas gain. The product will never synthesise, infer or report a protocol version from the installed CLI version; if a version must be shown, the honest value is "not offered by this surface".'
  },
  {
    id: 'unknown_method_rejection',
    title: '未知 RPC 一律拒绝且不记 ready',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '连接状态 / 运行时状态',
    evidence: cite('E-BUNDLE-002'),
    reason:
      'The dispatch switch terminates in `throw new sf(-32601, "Method not found: …")`, so an unknown method is a JSON-RPC error, not a silent success. The client side mirrors this: any reverse request outside the known set is answered with a JSON-RPC error and counted, never served.',
    nextEvidence: 'Same rejection observed against the real runtime (fixture alone is not enough to claim runtime behaviour).'
  },
  {
    id: 'account_ready',
    title: '账号 ready（received / spawn 均不等于）',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '账号与权益 / 账号状态',
    evidence: cite('E-HELP-001', 'E-BUNDLE-001'),
    reason:
      'A spawned process and an account-sync state of `received` are transport facts. No supported, read-only, zero-send method was found that returns an authoritative "this account is ready" answer. Nothing was authenticated, no credential was read, no `entitled:true`, no account revision and no activity ticket was fabricated.',
    nextEvidence: 'A coordinator-run zero-send readback of an official account state field, reviewed for staleness.'
  },
  {
    id: 'account_entitlement_readback',
    title: '账号资格（entitlement）精确读回',
    state: 'blocked',
    grade: 'E0',
    blocking: true,
    uiTarget: '账号与权益 / 套餐资格',
    evidence: cite('E-BUNDLE-001', 'E-BUNDLE-007'),
    reason:
      'The official method map contains no entitlement/plan-read method for the signed-in account. `permission.mode` is a per-run permission setting, not a subscription entitlement. With no readback, the product must not infer eligibility.',
    nextEvidence: 'An official, documented entitlement field readable with zero sends. Absent that, this stays blocked forever.'
  },
  {
    id: 'catalog_model_readback',
    title: '官方目录 / provider / model 精确读回',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '模型表格 / displayName, provider, modelId',
    evidence: cite('E-BUNDLE-001'),
    reason:
      'The method map has no catalogue/model-list method that could be read with zero sends. A directory name is not evidence, and this product may not guess or concatenate a modelId.',
    nextEvidence: 'A zero-send catalogue readback whose provider and modelId are read verbatim from the response.'
  },
  {
    id: 'billing_class_evidence',
    title: 'billing-evidence-map（计费类证据链）',
    state: 'blocked',
    grade: 'E0',
    blocking: true,
    uiTarget: '模型表格 / 计费类别 (subscription|promotion|metered_api|unknown)',
    evidence: cite('E-BUNDLE-009', 'E-BUNDLE-010'),
    reason:
      'The only billing-shaped official schema found is the OFF-PEAK / AUTOMATION task result, whose quota text is explicitly about idle-time task quota. It says nothing about what a chat request would be billed against. The chain official-field -> current-account-entitlement -> provider/model -> billing class has no established first and last link, so the class stays `unknown` and sending stays refused.',
    nextEvidence: 'An official per-model billing field plus an authoritative entitlement readback for the current account.'
  },
  {
    id: 'quota_source',
    title: 'quota 权威来源与单位',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '账号与权益 / 权威桶读数',
    evidence: cite('E-BUNDLE-001', 'E-BUNDLE-010'),
    reason:
      '`session/usage` and `usage/stats` exist as method names, but their response schema, unit and freshness were not read. Tokens and 积分/余额 are different units and must never be merged; concurrent sessions pollute any before/after delta.',
    nextEvidence: 'A zero-send usage readback with a documented unit and a stated staleness bound.'
  },
  {
    id: 'native_tool_disable_scope',
    title: '原生全部工具禁用（Read / 搜索 等）',
    state: 'blocked',
    grade: 'E0',
    blocking: true,
    uiTarget: '设置 / 发送门安全参数',
    evidence: cite('E-HELP-002', 'E-BUNDLE-006', 'E-BUNDLE-007', 'E-BUNDLE-008'),
    reason:
      'Two things exist: a CLI flag whose OWN HELP TEXT scopes it to "this prompt/TUI run only", and a `toolDisallowlist` field on a turn-input schema. A field on a schema proves the field exists, not that it reaches every native tool inside an app-server turn. Glob/Grep, Read and the rest are filtered by separate internal code paths. An incomplete control surface is worse than none, because it looks enforced.',
    nextEvidence: 'A zero-send round trip that sets toolDisallowlist and reads back the effective tool set, per tool family, on the app-server surface.'
  },
  {
    id: 'mcp_tool_disable_scope',
    title: 'MCP 工具禁用',
    state: 'blocked',
    grade: 'E0',
    blocking: true,
    uiTarget: '设置 / 发送门安全参数',
    evidence: cite('E-BUNDLE-006', 'E-BUNDLE-007'),
    reason:
      'MCP server registration is filtered against a disallowlist internally, and `interaction/requestOfficialMcpAuthHeaders` shows the runtime ASKS THE CLIENT for MCP auth headers. Whether a client-side refusal of those headers is a supported, complete off switch was not established. Refusing a header is not the same as disabling a tool.',
    nextEvidence: 'A documented, client-side MCP kill switch with a readback of the effective MCP tool set.'
  },
  {
    id: 'automation_task_disable_scope',
    title: '自动任务（automation / offPeak）禁用',
    state: 'blocked',
    grade: 'E0',
    blocking: true,
    uiTarget: '设置 / 发送门安全参数',
    evidence: cite('E-BUNDLE-001', 'E-BUNDLE-004', 'E-BUNDLE-009'),
    reason:
      'The runtime can create automation and off-peak tasks and can emit background turns on its own. No official switch was found that prevents a zero-send probe (or any session) from being followed by an unattended automated dispatch. Until there is one, the product cannot claim the native tool and automation surface is off.',
    nextEvidence: 'An official, complete control that disables scheduled/background dispatch, plus a readback proving it took effect.'
  },
  {
    id: 'permission_mode_is_not_tool_disable',
    title: 'plan/deny 权限模式 ≠ 禁用原生工具',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '设置 / 发送门安全参数',
    evidence: cite('E-HELP-003', 'E-BUNDLE-013', 'E-BUNDLE-006'),
    reason:
      'Confirmed as a negative result, which is exactly the point: `--mode` selects build|edit|plan|yolo for PROMPTS, and the permission engine denies on a rule set. A denied tool is a tool the runtime still holds and may still describe. Prompt/TUI permission semantics say nothing about app-server parity.',
    nextEvidence: 'Keep as a standing product rule: plan/deny never satisfies a "tools are off" gate.'
  },
  {
    id: 'retry_disable',
    title: '自动重试是否可禁',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '操作状态 / failed, outcome_unknown',
    evidence: cite('E-BUNDLE-011'),
    reason:
      'Retry state is definitely observable (`apiRetry`, `retryBudget`, `modelRetryBudget`, `canRetry`, `maxAttempts`, `retryAfterMs`), so an invisible automatic retry cannot be ruled out. No official key that sets the budget to zero was found. The product rule "a failed or unknown-outcome call is never auto-retried" therefore has to be enforced on OUR side, and we cannot yet prove the runtime does not also retry underneath.',
    nextEvidence: 'A documented zero/disabled retry budget applicable to the app-server surface, read back after a bounded no-send attempt.'
  },
  {
    id: 'terminal_state_correlation',
    title: 'input / turn / generation 精确终态关联',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '操作状态 / completed, failed, cancelled, outcome_unknown',
    evidence: cite('E-BUNDLE-008', 'E-BUNDLE-001'),
    reason:
      '`inputId`, `queryId`, `turnId`, `targetTurnId` and `traceId` appear in the turn/steer schemas, and stop state is reported as idle|stoppable|stopping. No terminal frame was ever observed, so the correlation between our own record and the terminal state of the runtime is unproven. An input that stops being acknowledged must stay `outcome_unknown`, never be marked completed.',
    nextEvidence: 'Observed request/response/terminal frames for one non-model operation, correlated by id.'
  },
  {
    id: 'precise_cancel',
    title: '精确 cancel（只取消自己发起的）',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '操作状态 / cancelled',
    evidence: cite('E-BUNDLE-001'),
    reason:
      '`session/stop` and `session/cancelBackgroundTask` exist as method names; whether a stop is scoped to one turn, one input or the whole session, and whether it can race a dispatch, was not established. A cancel that cannot be proven precise must not be reported as cancelled.',
    nextEvidence: 'Documented cancel scoping plus an observed stop-state transition on the app-server surface.'
  },
  {
    id: 'role_fidelity',
    title: '角色保真（user / assistant / tool 消息角色）',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '会话页 / 消息角色',
    evidence: cite('E-BUNDLE-001'),
    reason:
      'No message-role schema was read back. This product must not re-label, merge or synthesise a role; a role is taken verbatim from the official frame or not at all.',
    nextEvidence: 'A read-only message readback whose role field is displayed verbatim.'
  },
  {
    id: 'own_session_resume',
    title: 'ownSessionResume（只恢复本产品自己建立的会话）',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '会话页 / 会话标识',
    evidence: cite('E-BUNDLE-001'),
    reason:
      '`session/resume` exists and the bundle logs "session resume found no persisted record", so resuming a session that does not exist is a normal, reportable outcome. This product has created NO session yet, so it has never read a real session and must not claim it has. `--resume <sessionId>` in help is a CLI flag and is not evidence of an app-server field.',
    nextEvidence: 'A session created by this product, then resumed by sessionId with zero sends, with the id read back verbatim.'
  },
  {
    id: 'external_tools_continuation',
    title: '外部 tools 的 schema / call / result 续轮',
    state: 'unknown',
    grade: 'E0',
    blocking: true,
    uiTarget: '设置 / 外部工具',
    evidence: cite('E-BUNDLE-012', 'E-BUNDLE-004', 'E-BUNDLE-018'),
    reason:
      'Re-verified against the full official method map: it contains no external tool schema/call/result method. Every `tools/call` and `tools/list` in the bundle belongs to the MCP SDK schema table, not to the app-server dispatch. The app-server DOES send reverse requests to its client, but the server-registered-on-client table `HUi` holds only workspace/hooks/trustGrant, mcp/list, interaction/browserList and interaction/browserExecute — no external tool continuation. Whether such a continuation exists at all is unproven, so it stays unknown rather than assumed absent.',
    nextEvidence: 'An official reverse-request method for external tools, or an explicit statement that none exists.'
  },
  {
    id: 'account_config_write_never_used',
    title: '禁止用 provider/updateAccountConfig 反读账号',
    state: 'mechanism_verified',
    grade: 'E0',
    blocking: false,
    uiTarget: '账号与权益 / 账号状态',
    evidence: cite('E-BUNDLE-020'),
    reason:
      'A confirmed negative, recorded so the historical failure cannot be repeated. `provider/updateAccountConfig` exists in the official map and is a WRITE. The old 3.12.3 diagnostic approach of writing a guessed account config and reading the result back is a state-changing round trip against the signed-in account, and it is refused for the whole of I02 by FORBIDDEN_METHODS. No entitled flag, no revision and no ticket is inferred from it.',
    nextEvidence: 'Standing rule: entitlement must come from a documented read, never from a write\'s echo.'
  }
];

/** @param id look up one record */
export function getCapability(id: CapabilityId): CapabilityRecord {
  const found = CAPABILITY_MATRIX.find((c) => c.id === id);
  if (found === undefined) throw new Error(`capability-probe: unknown capability id: ${id}`);
  return found;
}

/**
 * Every record that forbids the corresponding product action.
 *
 * CORRECTED ON REVIEW: this used to read `c.blocking && c.state !== 'mechanism_verified'`,
 * which silently dropped any safety-bearing capability the moment its mechanism
 * was named. `zero_send_startup_handshake` would have left the blocking list the
 * day its schema was found, even though nothing has ever been observed. The
 * blocking flag is now the whole truth: naming a mechanism never unblocks an
 * action that has not been read back.
 */
export function blockingCapabilities(): readonly CapabilityRecord[] {
  return CAPABILITY_MATRIX.filter((c) => c.blocking);
}

/** `behavior_verified` may only be granted by a reviewed real run; see I02-F4. */
export function behaviourVerifiedCount(): number {
  return CAPABILITY_MATRIX.filter((c) => c.state === 'behavior_verified').length;
}

/** The fields of a record this rule reads. Lets a test forge a candidate. */
export type BehaviourClaimSubject = Pick<CapabilityRecord, 'id' | 'state' | 'blocking' | 'grade' | 'evidence'>;

/**
 * THE NARROWED RULE THAT GOVERNS `behavior_verified`, as an executable check.
 *
 * I02-F4 replaced the old closed rule ("never granted by this file") with an
 * open one ("a human-reviewed capture of the real process may grant it"). The
 * open form is what let `zero_send_startup_handshake` move, and it is correct
 * for that row: a pure observation of a server that does the whole startup
 * announcement by itself grants no send right, no entitlement and no usage.
 *
 * But the open form is also, on its own, too wide to be safe. It is a
 * can-only-rise rule with no mechanism to lower a row again, so "observation
 * is enough" would let the NEXT capture move `precise_cancel` or
 * `role_fidelity` off the blocking list. That is the regression this function
 * exists to make impossible, and it is checked per row, not by counting:
 *
 *   R1 a reviewed real-process capture MAY raise a row. A fixture may not:
 *      running our own stub is not observing the official process, and a
 *      behaviour observation is never a consumption proof, so the grade stays
 *      E0.
 *   R2 a row that gates a product action is NEVER unlocked by a capture.
 *      Action capabilities (`precise_cancel`, `role_fidelity`, the three
 *      `*_tool_disable_scope` rows, entitlement and quota readback, ...) need
 *      a product behaviour acceptance — someone exercising the product, not
 *      someone watching it. This is the clause that keeps the open rule from
 *      becoming a licence.
 *   R3 a capture can never turn `blocked` into `behavior_verified`. `blocked`
 *      means a required control surface is missing; a run that happened not to
 *      exercise it cannot establish that the surface exists.
 *   R4 a capture can never support `mechanism_verified`. It shows what one run
 *      did and nothing about why, which is the distinction the whole evidence
 *      table is built on (see `EvidenceLayer`).
 *
 * @param candidate the record as it would be written
 * @param prior the record as it stands today, when the question is a transition
 * @returns `null` if the record may hold its state, else the clause that refuses it
 */
export function behaviourClaimRefusal(
  candidate: BehaviourClaimSubject,
  prior?: Pick<CapabilityRecord, 'state' | 'blocking'>
): string | null {
  const layers = candidate.evidence.map((e) => e.layer);
  const hasCapture = layers.includes('official_process_capture');

  if (candidate.state === 'behavior_verified') {
    if (!hasCapture) {
      return 'R1: a behaviour claim needs a reviewed capture of the real official process; this record cites none';
    }
    if (layers.includes('own_fixture')) {
      return 'R1: a fixture is our own stub, not a run of the official process, and can never support a behaviour claim';
    }
    if (candidate.grade !== 'E0') {
      return `R1: ${candidate.id} is a behaviour observation, not a consumption proof, so it can not claim grade ${candidate.grade}`;
    }
    if (prior?.blocking === true) {
      return `R2: ${candidate.id} gates a product action; a capture may never move it off the blocking list — an action capability needs a product behaviour acceptance`;
    }
    if (candidate.blocking) {
      return `R2: ${candidate.id} is behaviour-verified AND blocking, which is incoherent: a behaviour row gates no product action`;
    }
    if (prior?.state === 'blocked') {
      return `R3: ${candidate.id} was blocked for a missing control surface; a capture can not prove that surface is present`;
    }
    return null;
  }

  if (candidate.state === 'mechanism_verified' && hasCapture && layers.every((l) => l === 'official_process_capture')) {
    return `R4: ${candidate.id} rests on a process capture alone, which shows what one run did and never why`;
  }
  return null;
}

/* ================================================================== *
 * 3. Method classification and the no-send write gate
 * ================================================================== */

export type MethodClass = 'control' | 'reverse_to_client' | 'potentially_model_dispatching' | 'unknown';

/**
 * Control-plane methods this product may read back with zero sends.
 *
 * Every entry is admitted only because an official source shows it is a read or
 * a local control. Anything NOT listed here is refused. The allowlist is
 * deliberately short: an unlisted method is treated as potentially
 * model-dispatching, because a method that is merely undocumented is far more
 * dangerous here than one that is merely inconvenient.
 *
 * CORRECTED ON REVIEW (twice).
 *   1. `interaction/browserList` used to be here. E-BUNDLE-018 shows it in
 *      `HUi`, the table the SERVER registers on the CLIENT, so it is a reverse
 *      request, not a method this product may send. Listing it here would have
 *      made `classifyMethod` answer 'control' (control is tested first) and the
 *      product would have written a method the server does not serve.
 *   2. REV4 I-5: fourteen further entries were admitted on E-BUNDLE-001 alone,
 *      which is a `...`-truncated dump of the official method-name map `va` and
 *      proves only that a NAME EXISTS. The list is now the two methods P4
 *      actually needs. The fourteen are preserved, with their reason, in
 *      PENDING_READ_ONLY_METHODS below.
 *
 * I02-F4, THIRD NARROWING: `startup/storagePathReady` is GONE, and its removal
 * is a conclusion rather than a cleanup. E-BUNDLE-026 shows the handshake it
 * answers belongs to the separate `app-server --prepare-storage` mode, and
 * E-BUNDLE-023 shows the full app-server logs "ZCode Protocol notification
 * ignored" for any frame with a method and no id — which is exactly this
 * frame's shape. A frame the peer discards by design is not a control-plane
 * read: keeping it on the allowlist meant the P4 acceptance number had to be 2,
 * and an operator reading `controlFrames === 2` would have had to reason about
 * a write that provably does nothing. It is now off the list, so
 * `classifyMethod('startup/storagePathReady')` answers
 * `potentially_model_dispatching`, `request()` refuses it by the ordinary gate
 * and counts the attempt, and no code path in this product can write it.
 * P4's acceptance is back to the single frame it actually needs.
 */
export const CONTROL_PLANE_METHODS: ReadonlyMap<string, string> = new Map([
  [
    'runtime/capabilities',
    'E-BUNDLE-003: the handler is a literal `case va.runtimeCapabilities:return{independentPlanState:!0}` — a compiled-in constant, so no provider, no storage and no write can be reached through it'
  ]
]);

/**
 * I-5. The fourteen methods that were on the write allowlist until the REV4
 * review, each with WHY it is no longer there.
 *
 * The old table admitted 16 methods and gave 14 of them the single justification
 * "E-BUNDLE-001". E-BUNDLE-001 is a `...`-truncated dump of the official method
 * map `va` — it proves a METHOD NAME EXISTS, and nothing whatsoever about what
 * the method DOES. Treating "the name is in the map" as "the method is a safe
 * read" contradicts this module's own admission rule, quoted above: "Every entry
 * is admitted only because an official source shows it is a read or a local
 * control." No such source was ever produced for these fourteen.
 *
 * Nothing has been deleted. Each method is still known to be a real official
 * method (the test `every control-plane method is a real official server method`
 * still pins the names against the official map). They are downgraded to
 * `unknown` about their side-effect profile and cannot be written.
 *
 * THE BAR FOR COMING BACK: a complete, verbatim official excerpt that shows the
 * server-side handler for that method — not the name table. A name in `va` is
 * not read-only evidence, and neither is this file's recollection of what a name
 * "sounds like" (`session/read` "reads a session", `mcp/list` "lists MCP
 * servers"). Three of these are plainly not reads of anything local:
 * `session/messages` returns persisted user messages, `session/subscribe`
 * REGISTERS a subscription on the server, and `session/usage` / `usage/stats`
 * have an UNKNOWN unit (tokens? credits? requests?) that no official excerpt has
 * pinned down.
 */
export const PENDING_READ_ONLY_METHODS: ReadonlyMap<string, string> = new Map([
  ['session/list', 'E-BUNDLE-001 shows the NAME only. The server-side handler was never read, so "list" is not established as side-effect-free.'],
  ['session/read', 'E-BUNDLE-001 shows the NAME only. Same gap; "read" in a method name is not a guarantee about the handler.'],
  ['session/messages', 'E-BUNDLE-001 shows the NAME only. It returns PERSISTED USER MESSAGES, so its disclosure surface was never established.'],
  ['session/events', 'E-BUNDLE-001 shows the NAME only. Whether it is a poll or a server-side registration was never read.'],
  ['session/subscribe', 'E-BUNDLE-001 shows the NAME only. "Subscribe" is a REGISTRATION on the server, which is a state change, not a read.'],
  ['session/subagents', 'E-BUNDLE-001 shows the NAME only. Handler unread.'],
  ['session/usage', 'E-BUNDLE-001 shows the NAME only, and the unit of the returned number is UNKNOWN (tokens / credits / requests were never pinned).'],
  ['usage/stats', 'E-BUNDLE-001 shows the NAME only, and the aggregation window and unit were never pinned.'],
  ['mcp/list', 'E-BUNDLE-001 shows the NAME only. Whether listing MCP servers touches the runtime\'s MCP connection state was never read.'],
  ['plugins/list', 'E-BUNDLE-001 shows the NAME only. Handler unread.'],
  ['skills/referenceCatalog', 'E-BUNDLE-001 shows the NAME only. Handler unread.'],
  ['plugins/referenceCatalog', 'E-BUNDLE-001 shows the NAME only. Handler unread.'],
  ['process/childProcesses', 'E-BUNDLE-001 shows the NAME only. It enumerates OTHER processes, whose identity and command lines are user data.'],
  ['session/debug', 'E-BUNDLE-001 shows the NAME only. "debug" is the least evidence-bearing name in the table; the handler was never read.']
]);

/**
 * I-1, part 1: whether `startup/storagePathReady` must be answered for the
 * startup handshake to complete.
 *
 * ORIGINALLY ANSWERED "NO" by re-scanning the shipped bundle (read-only static
 * inspection, no app-server started). `startup/storagePathReady` occurs EXACTLY
 * ONCE in `zcode.cjs`, inside the definition of the schema symbol `JUi`. The
 * only other references to `JUi` are the module's export surface
 * (`zcodeStoragePathReadySchema:()=>JUi`). There is no dispatch-table entry, no
 * handler and no `await` on a ready-promise anywhere in the bundle. On that
 * evidence alone the reply was left unsent.
 *
 * I02-F2-3: THAT ANSWER IS NOW SUPERSEDED BY AN OBSERVATION, and the ruling is
 * the coordinator's, not this task's. The first real P4 run
 * (review-artifacts/929/probe-r1-p4.json) sent its one frame into a server that
 * had already emitted five `startup/storageState` frames and exited. The static
 * scan is still true — the reply is still not awaited anywhere in the bundle —
 * but "the server exits the instant storage is ready and this client never
 * answers" is now a plausible, evidence-backed reason rather than a guess.
 *
 * I02-F4: THIS ENTIRE THREAD IS NOW CLOSED, and the answer is "the reply is
 * removed". Two static facts settled it — E-BUNDLE-026, the handshake belongs to
 * the separate `--prepare-storage` mode, and E-BUNDLE-023, the app-server
 * discards id-less notifications by design — and the coordinator's real runs
 * then observed what this entry had only inferred: the five storageState frames
 * arrive, in order, ending in `ready`, with the client having written nothing
 * at all (E-PROBE-R3-P4). There is no round trip to complete, so there is no
 * reply to send.
 *
 * The record is KEPT, in full, because its history is the point: a static scan
 * said "not awaited", a false premise ("the server exits without it") briefly
 * made it look plausible, and only a verbatim reading of the mode switch showed
 * it belonged to a different product surface. Nothing below is rewritten; the
 * `actionTaken` line is the only field that moved, and it now says removed.
 */
export const PENDING_REPLY_DECISION: Readonly<{
  readonly method: string;
  readonly occurrencesInOfficialBundle: 1;
  readonly otherReferences: 'module export surface only (zcodeStoragePathReadySchema)';
  readonly dispatchHandlerFound: false;
  readonly awaitedByStartup: 'unproven';
  readonly observedServerExitWithoutIt: true;
  readonly actionTaken: 'REMOVED in I02-F4: off the write allowlist, the client option and the write site are all gone, so no run of this product can produce the frame; the trigger derivation below is retained as a record only';
}> = {
  method: 'startup/storagePathReady',
  occurrencesInOfficialBundle: 1,
  otherReferences: 'module export surface only (zcodeStoragePathReadySchema)',
  dispatchHandlerFound: false,
  awaitedByStartup: 'unproven',
  observedServerExitWithoutIt: true,
  actionTaken: 'REMOVED in I02-F4: off the write allowlist, the client option and the write site are all gone, so no run of this product can produce the frame; the trigger derivation below is retained as a record only'
};

/**
 * I02-F3-2. THE OFFICIAL OUTBOUND FRAME SHAPE, and the defect it exposes.
 *
 * Before this, `request()` encoded `{jsonrpc:"2.0",id,method,params}`. That
 * shape came from generic JSON-RPC practice, not from the official protocol,
 * and E-BUNDLE-021 shows it is not the official one:
 *
 *   qir = m.object({id:yYe,method:Dn,params:m.unknown().optional(),trace:$Ht.optional()}).strict()
 *
 * There is no `jsonrpc` member, and the object is `.strict()`. Every frame this
 * product wrote therefore failed the official message union
 * `qHt=m.union([qir,Wir,Vir,Hir])` at `decodeLine`, and the server answered with
 * `sendError("invalid-message",-32600,"Invalid ZCode Protocol message",{issues})`
 * — a frame whose `id` is the 15-character reason literal and NOT our request
 * id. That is exactly the P4-R2 observation, and it is why correlation failed
 * with a live, answering server.
 *
 * The response side is equally un-`jsonrpc`: `ok(t,n){return{id:t,result:n}}`
 * and `fail(t,n,o,s){return{error:{code:n,data:s,message:o},id:t}}`
 * (E-BUNDLE-024). The captured error frame's top-level keys were exactly
 * ["error","id"], which is that literal.
 *
 * `id` is `yYe=m.union([m.string(),m.number().int()])`, so the string ids this
 * product assigns ("c1", "c2", …) are valid and stay.
 */
export const OFFICIAL_REQUEST_FRAME_MEMBERS: readonly string[] = ['id', 'method', 'params', 'trace'];
export const OFFICIAL_NOTIFICATION_FRAME_MEMBERS: readonly string[] = ['method', 'params', 'trace'];
export const OFFICIAL_RESPONSE_FRAME_MEMBERS: readonly string[] = ['id', 'result'];
export const OFFICIAL_ERROR_FRAME_MEMBERS: readonly string[] = ['id', 'error'];

/** @param method @param params @param id the exact official request frame */
export function buildOfficialRequestFrame(id: string, method: string, params: unknown): Record<string, unknown> {
  return { id, method, params };
}

/** @param method the exact official notification frame (no `id` slot at all) */
export function buildOfficialNotificationFrame(method: string, params?: unknown): Record<string, unknown> {
  return params === undefined ? { method } : { method, params };
}

/**
 * I02-F3-2. Where the `startup/storagePathReady` handshake actually lives, and
 * what that means for the reply P4 writes.
 *
 * E-BUNDLE-026 settles it. `zcode app-server` accepts `--prepare-storage`,
 * forwards it as `prepareStorageOnly`, and the agent branches:
 *
 *   prepareStorageOnly -> `jHo` (E-BUNDLE-025): write `startup/storagePath`,
 *                        block up to 30 000 ms for ONE `storagePathReady`
 *                        line, open the storage, write `startup/storagePrepared`.
 *                        Then RETURN — it is a storage-preparation-only mode.
 *   full app-server    -> `lPn` directly: open the storage, stream
 *                        `startup/storageState`. No storagePath, no wait, no
 *                        storagePrepared.
 *
 * The P1-P4 probe spawns `zcode app-server` with NO `--prepare-storage`, so it
 * is the second branch — and the real capture is exactly that: five
 * `startup/storageState` frames and nothing else. E-BUNDLE-023 adds the second
 * half: the app-server's inbound handler logs
 * "ZCode Protocol notification ignored" for any frame with a `method` and no
 * `id`, which is precisely the shape of the reply.
 *
 * SO: on this surface the reply is INERT BY OFFICIAL DESIGN. It is not the
 * cause of the R2 failure and it is not its cure.
 *
 * I02-F4: THE COORDINATOR ADJUDICATED IT AND IT IS NOW GONE. Round 3 proved P4
 * works without it (`{"independentPlanState":true}`, id correlated, zero model
 * frames), which is the experiment §12.9 asked for, and this finding is what
 * that experiment was waiting on. So the reply was removed rather than left in
 * as a harmless no-op: the write allowlist is back to a single method, the
 * client option, the write site and the `controlFrames` second unit are all
 * deleted, and `classifyMethod('startup/storagePathReady')` now answers
 * `potentially_model_dispatching` so even a direct `request()` is refused and
 * counted. This finding stays, because it is the reason the removal is correct
 * rather than merely tidy — and because it is printed in every probe report.
 */
export const STARTUP_REPLY_SURFACE_FINDING: Readonly<{
  readonly surfaceUnderTest: 'zcode app-server (no --prepare-storage)';
  readonly handshakeBelongsTo: 'zcode app-server --prepare-storage (prepareStorageOnly), a storage-preparation-only mode';
  readonly officialSequenceThere: readonly string[];
  readonly officialServerBehaviourForANotification: 'ignored by design — E-BUNDLE-023 logs "ZCode Protocol notification ignored"';
  readonly observedOnTheSurfaceUnderTest: 'five startup/storageState frames (checking, checking, checking, committing, ready), no startup/storagePath, no startup/storagePrepared, no storagePathReady round trip — E-PROBE-R3-P4';
  readonly conclusion: 'no client half exists on this surface; the reply was inert here, was neither cause nor cure of the R2 failure, and has now been removed';
  readonly actionTaken: 'REMOVED in I02-F4 — off the write allowlist, option, write site and controlFrames; the trigger derivation is kept as STARTUP_REPLY_TRIGGER, a record only';
  readonly removedAfterP4SucceededWithoutIt: true;
}> = {
  surfaceUnderTest: 'zcode app-server (no --prepare-storage)',
  handshakeBelongsTo: 'zcode app-server --prepare-storage (prepareStorageOnly), a storage-preparation-only mode',
  officialSequenceThere: [
    'server -> client: {"method":"startup/storagePath","params":{"path":<dbPath>}}',
    'client -> server: one line, {"method":"startup/storagePathReady"} or {"method":"startup/storagePathReady","reuse":<bool>} (E-BUNDLE-015; omitted reuse === false), within 30 000 ms',
    'if reuse !== true: server opens storage and streams {"method":"startup/storageState","params":{…}} frames',
    'server -> client: {"method":"startup/storagePrepared","params":{}}'
  ],
  officialServerBehaviourForANotification: 'ignored by design — E-BUNDLE-023 logs "ZCode Protocol notification ignored"',
  observedOnTheSurfaceUnderTest: 'five startup/storageState frames (checking, checking, checking, committing, ready), no startup/storagePath, no startup/storagePrepared, no storagePathReady round trip — E-PROBE-R3-P4',
  conclusion: 'no client half exists on this surface; the reply was inert here, was neither cause nor cure of the R2 failure, and has now been removed',
  actionTaken: 'REMOVED in I02-F4 — off the write allowlist, option, write site and controlFrames; the trigger derivation is kept as STARTUP_REPLY_TRIGGER, a record only',
  removedAfterP4SucceededWithoutIt: true
};

/**
 * Methods that provably exist in the official method map and that this product
 * refuses to send for the whole of I02, each with the reason it is dangerous.
 *
 * This is not the same as the control-plane allowlist. The allowlist says "may
 * be read with zero sends". This set says "is on the official list and is
 * nonetheless never sent", so that promoting one into the allowlist later is a
 * deliberate, reviewable act instead of a silent widening.
 */
export const FORBIDDEN_METHODS: ReadonlyMap<string, string> = new Map([
  ['session/send', 'E-BUNDLE-020: the model-dispatch entry point. The one thing I02 may never write.'],
  ['workspace/generateText', 'E-BUNDLE-020: a second, independent model-dispatch entry point.'],
  ['provider/testModelConnectivity', 'E-BUNDLE-020: opens a provider connection; "test" is not "read".'],
  ['provider/updateAccountConfig', 'E-BUNDLE-020: a WRITE to account config. Reading a guessed account config by round-tripping this is exactly the historical 3.12.3 failure the contract forbids.'],
  ['offPeak/create', 'E-BUNDLE-020: creates an unattended off-peak task, i.e. a later background dispatch we would not be watching.'],
  ['automation/create', 'E-BUNDLE-020: the same, for automation.'],
  ['session/resume', 'E-BUNDLE-001: this product has created no session, so there is nothing of its own to resume.'],
  ['session/stop', 'E-BUNDLE-001: stop scoping is unproven, so a stop could cancel a dispatch we do not own.'],
  ['session/cancelBackgroundTask', 'E-BUNDLE-001: same reason as session/stop.']
]);

/**
 * Methods the RUNTIME sends to US. Unknown ones are refused, never served.
 * E-BUNDLE-018 pins `interaction/browserList` and `interaction/browserExecute` to
 * this direction via the server-registered-on-client handler table `HUi`.
 */
export const REVERSE_REQUEST_METHODS: ReadonlySet<string> = new Set([
  'interaction/requestPermission',
  'interaction/requestUserInput',
  'interaction/requestProviderRuntimeHeaders',
  'interaction/requestOfficialMcpAuthHeaders',
  'interaction/browserList',
  'interaction/browserExecute',
  'workspace/hooks/trustGrant',
  'session/requestRuntimePreferences',
  'computer-use/operation-event'
]);

/**
 * Methods this product refuses to answer on the reverse channel.
 * `interaction/requestOfficialMcpAuthHeaders` and
 * `interaction/requestProviderRuntimeHeaders` are here on purpose: handing back
 * runtime or MCP credentials is exactly the "never export a secret" rule, and
 * answering them is the one reverse request that could turn a probe into a
 * paid, authenticated path.
 *
 * Under I02 this equals the whole known reverse set: there is no reverse request
 * this product will ever serve, so the two sets are kept as separate names to
 * make that an explicit decision rather than a coincidence.
 */
export const REFUSED_REVERSE_METHODS: ReadonlySet<string> = new Set(REVERSE_REQUEST_METHODS);

/** @param method classify a method name by the direction and risk it carries */
export function classifyMethod(method: string): MethodClass {
  if (FORBIDDEN_METHODS.has(method)) return 'potentially_model_dispatching';
  if (CONTROL_PLANE_METHODS.has(method)) return 'control';
  if (REVERSE_REQUEST_METHODS.has(method)) return 'reverse_to_client';
  return 'potentially_model_dispatching';
}

export interface SendLedger {
  /**
   * Frames actually written that could reach a provider. MUST stay 0.
   *
   * I-3: the single increment for this counter sits at the ONE place bytes
   * reach stdin, so it is a live tripwire rather than a decoration: remove or
   * move the structural gate in `request()` past the write and this goes to 1.
   */
  readonly modelDispatch: number;
  /**
   * I-3: every call to `request()` naming a method that is NOT on the control
   * allowlist, counted whether or not it was sent — a refused method counts too.
   *
   * This is the counter that carries information. Before the fix there was no
   * increment anywhere in the client, so `assertNoModelDispatch()` could not
   * possibly throw and "measured twice and independently" counted one real
   * observation plus one decoration. A non-zero value here is NOT a violation:
   * it means somebody asked for a dispatching method and the structural gate
   * stopped it before a byte was encoded. It becomes a violation only if
   * `modelDispatch` is also non-zero, or if a probe run reaches the end of the
   * command with this non-zero without having recorded the refusal.
   */
  readonly modelDispatchAttempts: number;
  /**
   * Control-plane REQUEST frames written. EXCLUDES JSON-RPC error/refusal
   * frames: those are counted by `refusalFrames`, never by this counter, so
   * `controlFrames === 0` means "this run sent no request of its own" and is not
   * silently falsified by refusing a reverse request.
   */
  readonly controlFrames: number;
  /**
   * JSON-RPC refusal frames written back down the reverse channel. I-4: these
   * ARE bytes this product writes. Reporting only `refusedReverse` hid that a
   * frame went out, so the byte count is now explicit.
   */
  readonly refusalFrames: number;
  /** Outbound methods refused by the write gate. */
  readonly refusedPotentiallyDispatching: number;
  /** Reverse requests refused with a JSON-RPC error. */
  readonly refusedReverse: number;
  /** Reverse requests the client answered. */
  readonly servedReverse: number;
}

export interface MutableLedger {
  modelDispatch: number;
  modelDispatchAttempts: number;
  controlFrames: number;
  refusalFrames: number;
  refusedPotentiallyDispatching: number;
  refusedReverse: number;
  servedReverse: number;
}

export class ModelDispatchAttemptError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`REFUSED: method "${method}" is not on the zero-send control-plane allowlist and may dispatch a model request`);
    this.name = 'ModelDispatchAttemptError';
    this.method = method;
  }
}

/* ================================================================== *
 * 4. Bounded NDJSON transport over stdio
 * ================================================================== */

export interface TransportLimits {
  /** Largest single incoming NDJSON frame. */
  readonly maxFrameBytes: number;
  /** Largest un-parsed concatenation buffer. */
  readonly maxBufferBytes: number;
  /** Largest metadata blob the product will accept or emit. */
  readonly maxMetadataBytes: number;
}

/**
 * Engineering budget for this product. NOT an official limit.
 *
 * E-BUNDLE-019 shows the official transport has its own physical-frame bound
 * (`QI.maxPhysicalFrameBytes`, enforced with a base64/CRC32 physical framing and
 * the terminal fault `remote.rpcFrame.envelopeTooLarge`). The numeric value was
 * not read, so no claim is made about it here. What matters for I02 is only that
 * these product limits are the TIGHTER constraint, so an oversize frame is
 * refused on our side of the pipe before the official framing is ever involved.
 */
export const DEFAULT_LIMITS: TransportLimits = {
  maxFrameBytes: 2 * 1024 * 1024,
  maxBufferBytes: 4 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024
};

export type FrameErrorCode =
  | 'MALFORMED_JSON'
  | 'FRAME_TOO_LARGE'
  | 'BUFFER_TOO_LARGE'
  | 'METADATA_TOO_LARGE'
  | 'ID_NOT_CORRELATABLE'
  | 'TIMEOUT'
  | 'EOF_WITH_PENDING'
  | 'CHILD_ERROR';

export interface ProtocolFrame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
  readonly [key: string]: unknown;
}

export type TransportOutcome =
  | { readonly kind: 'ok'; readonly frame: ProtocolFrame; readonly dispatchOrdinal: number }
  | { readonly kind: 'error'; readonly code: FrameErrorCode; readonly detail: string; readonly dispatchOrdinal: number };

export interface ChildIdentity {
  readonly pid: number | null;
  /** Random value generated by the parent and echoed by our own child at startup. */
  readonly nonce: string;
  readonly spawnedAtIso: string;
}

export interface NoSendClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly nonce: string;
  readonly limits?: TransportLimits;
  readonly requestTimeoutMs?: number;
  /** Reject reverse requests instead of answering them. Defaults to true. */
  readonly refuseAllReverseRequests?: boolean;
  readonly envExtra?: Readonly<Record<string, string>>;
  /**
   * I02-F2-3 added `replyStartupStoragePathReady` here, to arm the
   * `startup/storagePathReady` reply in the doubly-acknowledged P4 path.
   *
   * I02-F4 REMOVED THE OPTION ALONG WITH THE WRITE PATH. It is not deprecated
   * and it is not ignored: the field no longer exists on this type, so a caller
   * that still passes it fails `tsc` rather than silently acquiring a write.
   * The reason is in STARTUP_REPLY_SURFACE_FINDING — the handshake belongs to
   * `app-server --prepare-storage`, and this surface discards id-less
   * notifications by design.
   */
  /**
   * Called synchronously immediately BEFORE any control-plane frame this client
   * originates is written, with the exact bytes' method. The CLI uses it to
   * print to stderr before the write, so an operator's record shows what went
   * out even if the child dies on the next instruction. A hook is used rather
   * than a direct `process.stderr.write` so this module never writes to a
   * stream the host application did not offer it.
   */
  readonly onControlWrite?: (info: ControlWriteInfo) => void;
}

/** @param {any} info @returns {void} */
function noopControlWrite(info: ControlWriteInfo): void {
  void info;
}

export interface ControlWriteInfo {
  readonly method: string;
  /** The exact line that will be written, newline included. */
  readonly line: string;
  /**
   * I02-F4: `'request'` is now the ONLY value. The `'startup_reply'` variant
   * existed solely for the removed handshake reply, and a single-valued union is
   * kept (rather than deleted) so a caller written against the old shape fails
   * to compile instead of matching a variant that can no longer occur.
   */
  readonly why: 'request';
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * I02-F2-2. Cap on captured child stderr. The text is the ONLY first-hand
 * reason a child can give for dying, so it is captured in full up to this many
 * bytes and marked `truncated` past it — the alternative, the previous
 * behaviour, reported "EOF_WITH_PENDING / child stdout closed" and no cause at
 * all, which is how four P-runs (P2, P3, P4) produced no actionable evidence.
 */
const MAX_CHILD_STDERR_BYTES = 64 * 1024;

export interface ChildStderrCapture {
  /** Decoded once from the collected bytes, so a split multi-byte glyph is safe. */
  readonly text: string;
  /** Bytes the child actually emitted, before any cap. */
  readonly bytes: number;
  /** True when `bytes` exceeded the cap and `text` is only the first part. */
  readonly truncated: boolean;
  readonly capBytes: number;
}

/**
 * I02-F2-3. WHY the reply goes after `phase === "ready"`, and how certain that is.
 *
 * OBSERVED (review-artifacts/929/probe-r1-full-frames.json, one real capture with
 * zero frames sent by the client, child exit 1, empty stderr). Five frames, all
 * the `startup/storageState` variant of the E-BUNDLE-014 union:
 *
 *   seq 1  phase=checking
 *   seq 2  phase=checking
 *   seq 3  phase=checking   + migration {kind:"none", executedCount:0, committedCount:0}
 *   seq 4  phase=committing + migration {..., lastAppliedMigrationId:"0022_backfilled_session_reasoning"}
 *   seq 5  phase=ready      + migration {..., lastAppliedMigrationId:"0022_backfilled_session_reasoning"}
 *
 * DERIVED FROM THE BUNDLE. E-BUNDLE-016 types `phase` as an enum of exactly six
 * members — checking, waiting_for_lock, migrating, committing, ready, failed —
 * so `ready` and `failed` are the only two terminal values, and `ready` is the
 * only terminal SUCCESS. E-BUNDLE-015 types the client reply as
 * `JUi=m.object({method:m.literal("startup/storagePathReady"),reuse:m.boolean().optional()}).strict()`:
 * a strict object whose ONLY fields are the method and an optional boolean.
 *
 * CONCLUSION ON SHAPE. The acknowledgement is emitted on the transition into
 * the terminal success phase and not before, because that is the last thing the
 * server's own state machine says about storage. It is emitted as a
 * NOTIFICATION, not a request: E-BUNDLE-014/015 declare these startup frames
 * as `{method, params}` with no `id` and no `jsonrpc` slot, which is exactly the
 * shape the capture shows on the wire, so a frame carrying `id` or `jsonrpc`
 * would violate the official `.strict()` schema. `reuse` is OMITTED: it is
 * optional, its meaning is unread, and guessing a boolean is a guess.
 *
 * THE PREMISE THIS WAS AUTHORISED ON IS NOW FALSIFIED — read this before
 * trusting the trigger. The authorisation rested on "the server emits five
 * frames and then exits". EXP-LIFETIME (task-I02-report.md §11.2) started the
 * official app-server with the measured environment, wrote ZERO frames and left
 * stdin OPEN and idle: all five frames arrived within 863 ms and the process
 * was still alive at 20 000 ms, when this project's OWN handle killed it
 * (exitCode null, signal SIGKILL, stderr empty). The runtime does NOT exit on
 * its own. The exit 1 in probe-r1 therefore came from the PROBE'S OWN TEARDOWN
 * — `close()` calls `stdin.end()`, and the runtime exits on closed protocol
 * input — and the root cause of the whole round-1 failure is the environment
 * allowlist (F2-1), not a missing handshake.
 *
 * The reply is still implemented, because the coordinator authorised it and it
 * is harmless where it sits: doubly acknowledged only, one strict object with
 * an optional boolean, no state change, no provider contact, counted in
 * `controlFrames`. But it is NOT established to be needed, the coordinator
 * should re-decide with the lifetime evidence in hand, and if the next real P4
 * succeeds with the reply switched off the honest action is to switch it off.
 *
 * I02-F4: THE CONDITION WAS MET AND THE HONEST ACTION WAS TAKEN. The
 * coordinator's round-3 P4 succeeded with the reply in place and the reply
 * proven inert (E-PROBE-R3-P4, E-BUNDLE-023/026), so the write path described
 * above — the client option, the armed getter, the record type and the write
 * site — has been DELETED, not disabled. What survives is the derivation
 * itself, below, exported and asserted as a record: a plausible trigger built
 * on a falsified premise, kept precisely so nobody re-derives it.
 */
/**
 * The E-BUNDLE-016 `phase` enum, hoisted so the transport class and the shape
 * summary in §4b can share ONE copy. Six members, verbatim; the earlier report
 * text said seven and was wrong.
 */
export const OFFICIAL_PHASE_ENUM: readonly string[] = [
  'checking', 'waiting_for_lock', 'migrating', 'committing', 'ready', 'failed'
];

export const STARTUP_REPLY_TRIGGER: Readonly<{
  readonly method: 'startup/storageState';
  readonly phase: 'ready';
  readonly wireShape: '{"method":"startup/storagePathReady"}';
  readonly basis: 'derived from the observed phase sequence + E-BUNDLE-014/015/016; NOT observed to be correct, and its motivating premise was falsified by EXP-LIFETIME';
  readonly certainty: 'observed-inert-on-the-probed-surface-e-bundle-023-and-026';
  readonly supersededBy: 'STARTUP_REPLY_SURFACE_FINDING (E-BUNDLE-023/025/026)';
  /**
   * I02-F4. Nothing reads this any more. It is kept, exported and asserted
   * because it is the record of a derivation that LOOKED load-bearing and was
   * not — the whole reason a reader should not re-derive a startup trigger from
   * the phase sequence. It is documentation, not a switch.
   */
  readonly status: 'retired-in-i02-f4; no code path writes the frame it describes';
}> = {
  method: 'startup/storageState',
  phase: 'ready',
  wireShape: '{"method":"startup/storagePathReady"}',
  // I02-F3-2. `basis` keeps the original derivation so the record of how the
  // trigger was reached is not rewritten. `certainty` is what changed: the
  // forensic pass established that the handshake this reply answers belongs to
  // the `--prepare-storage` mode (E-BUNDLE-026) and that the app-server's own
  // inbound handler IGNORES id-less notifications by design (E-BUNDLE-023), so
  // on the surface under test the reply provably has no effect. I02-F4 then
  // deleted the write path, which is what `status` records.
  basis: 'derived from the observed phase sequence + E-BUNDLE-014/015/016; NOT observed to be correct, and its motivating premise was falsified by EXP-LIFETIME',
  certainty: 'observed-inert-on-the-probed-surface-e-bundle-023-and-026',
  supersededBy: 'STARTUP_REPLY_SURFACE_FINDING (E-BUNDLE-023/025/026)',
  status: 'retired-in-i02-f4; no code path writes the frame it describes'
};

/**
 * One observed startup announcement, in the same value-free style as
 * `describeFrameShape`: the `method` and `phase` VALUES are protocol constants
 * and are the acceptance criterion, while every identifier stays a length.
 */
export interface StartupFrameSummary {
  /** 1-based position in this run's inbound frame stream. */
  readonly index: number;
  readonly methodName: string | null;
  /** The `sequence` field of the params, when present. A number, not a value. */
  readonly sequence: number | null;
  /** The `phase` enum member. This IS printed — a protocol constant, not data. */
  readonly phase: string | null;
  /** Whether `phase` is a member of the E-BUNDLE-016 enum. */
  readonly phaseIsOfficialEnumMember: boolean;
}

interface Waiter {
  readonly resolve: (outcome: TransportOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
  /**
   * I02-F3-3. Set for a `request()` waiter, null for a `nextFrame()` waiter.
   *
   * This one field is the whole F3-3 fix. A `request()` waiter is only
   * satisfied by a frame that is a RESPONSE (or an error response) whose `id`
   * is strictly equal to the id we sent; anything else — a startup
   * notification, an unrelated id, a `{"id":"invalid-message"}` diagnostic —
   * is recorded in the frame log and the waiter KEEPS WAITING until its
   * timeout. Before this, `#consumeLine` handed the first inbound frame of any
   * shape to the first waiter, so a single rejection frame terminated the wait
   * and the report could only ever conclude "unproven".
   */
  readonly expectId: string | null;
}

/**
 * I02-F3-3. How an inbound frame is classified, using the official message
 * guards read verbatim in E-BUNDLE-023:
 *   `VHo(e){return"method"in e&&"id"in e}`   -> server->client REQUEST
 *   `HHo(e){return"method"in e&&!("id"in e)}` -> server->client NOTIFICATION
 *   `GHo(e){return"id"in e&&"result"in e}`   -> success RESPONSE
 *   `JHo(e){return"id"in e&&"error"in e}`    -> error RESPONSE
 */
export type InboundFrameKind = 'request' | 'notification' | 'response' | 'error_response' | 'unrecognised';

export interface InboundFrameRecord {
  /** 1-based position in this run's inbound frame stream, in arrival order. */
  readonly index: number;
  readonly kind: InboundFrameKind;
  /** The `method` VALUE when there is one. A protocol constant, not user data. */
  readonly methodName: string | null;
  readonly hasId: boolean;
  readonly idType: JsonTypeName;
  /**
   * UTF-16 length of a string id, or null. The VALUE is never recorded here;
   * F3-1's `errorValues` is the only place an id value is ever exposed, and
   * only on the P4 path.
   */
  readonly idStringLength: number | null;
  /** true when this frame satisfied a `request()` waiter, i.e. the ids matched. */
  readonly correlatedToRequest: boolean;
  /** The method of the pending request this frame was tested against, if any. */
  readonly evaluatedAgainstMethod: string | null;
}

/** @param frame one parsed inbound frame @returns {InboundFrameKind} */
export function classifyInboundFrame(frame: ProtocolFrame): InboundFrameKind {
  const hasMethod = frame['method'] !== undefined;
  const hasId = frame['id'] !== undefined;
  if (hasId && frame['result'] !== undefined) return 'response';
  if (hasId && frame['error'] !== undefined) return 'error_response';
  if (hasMethod && hasId) return 'request';
  if (hasMethod) return 'notification';
  return 'unrecognised';
}

/**
 * A bounded NDJSON-over-stdio client with a structural no-send gate.
 *
 * Framing is done on BYTES, then decoded per complete line, because 0x0A can
 * never occur inside a multi-byte UTF-8 sequence. A CJK payload split across
 * chunk boundaries therefore decodes correctly, and the size limits are exact
 * rather than approximate.
 *
 * Resource contract: every waiter is unqueued exactly once, every timer is
 * cleared, every listener is removed in `close()`, and the only process ever
 * signalled is the handle this object created.
 */
export class NoSendStdioClient {
  readonly limits: TransportLimits;
  #child: ReturnType<typeof spawn> | null = null;
  #pid: number | null = null;
  #waiters: Waiter[] = [];
  #ready: ProtocolFrame[] = [];
  #pendingBytes: Buffer[] = [];
  #pendingByteLength = 0;
  #ledger: MutableLedger = {
    modelDispatch: 0,
    modelDispatchAttempts: 0,
    controlFrames: 0,
    refusalFrames: 0,
    refusedPotentiallyDispatching: 0,
    refusedReverse: 0,
    servedReverse: 0
  };
  #dispatchOrdinal = 0;
  #framesSeen = 0;
  #closed = false;
  #fatal: FrameErrorCode | null = null;
  #fatalDetail = '';
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #exitWaiters: ((v: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
  #envReport: EnvSanitizeReport = { forwarded: [], denied: [], withheldNames: [] };
  // I02-F2-2. Bytes are buffered and decoded once at the accessor, for the
  // same reason stdout framing is byte-level: a CJK glyph split across two
  // reads must not become two U+FFFD.
  #stderrChunks: Buffer[] = [];
  #stderrBytes = 0;
  #stderrTruncated = false;
  // I02-F2-3. Only the OBSERVATION half of that round survives: the startup
  // frames are still recorded, because E-PROBE-R3-P4 shows the sequence is the
  // evidence the zero-send claim rests on. The reply's own state is gone.
  #startupFrames: StartupFrameSummary[] = [];
  // I02-F3-3.
  #frameLog: InboundFrameRecord[] = [];
  #requestSeq = 0;
  readonly #onControlWrite: (info: ControlWriteInfo) => void;
  readonly #options: NoSendClientOptions;
  readonly #nonce: string;
  readonly #spawnedAtIso: string;
  readonly #refuseAllReverse: boolean;

  constructor(options: NoSendClientOptions) {
    this.#options = options;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.#refuseAllReverse = options.refuseAllReverseRequests ?? true;
    this.#onControlWrite = options.onControlWrite ?? noopControlWrite;
    this.#nonce = options.nonce;
    this.#spawnedAtIso = new Date().toISOString();
  }

  /**
   * Identity proof for the one child this object created: the handle's pid plus
   * a nonce generated by the parent before spawn. Reclaiming is only ever done
   * through this object's own handle, never by name, port or wildcard.
   */
  get identity(): ChildIdentity {
    return { pid: this.#pid, nonce: this.#nonce, spawnedAtIso: this.#spawnedAtIso };
  }

  get ledger(): SendLedger {
    return { ...this.#ledger };
  }

  get framesSeen(): number {
    return this.#framesSeen;
  }

  get pendingWaiters(): number {
    return this.#waiters.length;
  }

  /**
   * I-1. The JSON-RPC id the NEXT `request()` will use.
   *
   * A caller that has to prove "the frame I read back is the answer to the
   * frame I sent" cannot guess this: `nextFrame()` also advances the ordinal, so
   * the first request after one passively observed frame is `c2`, not `c1`.
   * P4 uses this to report `responseIdMatchedRequest` instead of assuming the
   * correlation.
   */
  nextRequestId(): string {
    return `c${this.#dispatchOrdinal + 1}`;
  }

  get bufferedByteLength(): number {
    return this.#pendingByteLength;
  }

  get fatal(): { code: FrameErrorCode; detail: string } | null {
    return this.#fatal === null ? null : { code: this.#fatal, detail: this.#fatalDetail };
  }

  /**
   * "Ready" means: no fatal framing event, the child is alive, and the
   * handshake completed. Any malformed frame, any oversize frame and any EOF
   * with work in flight makes this permanently false.
   */
  get ready(): boolean {
    return this.#fatal === null && this.#child !== null && this.#exit === null;
  }

  get envReport(): EnvSanitizeReport {
    return this.#envReport;
  }

  /**
   * I02-F2-2. Everything the child wrote to stderr, decoded once.
   *
   * Read this AFTER `close()`: a child that dies on a fatal error writes its
   * reason last, so a value read at the moment of the failure can be empty even
   * though the reason exists. The report field is still routed through
   * `redact()`, so a secret-shaped substring inside a crash dump is not
   * published by virtue of being a crash dump.
   */
  get childStderr(): ChildStderrCapture {
    return {
      text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(this.#stderrChunks)),
      bytes: this.#stderrBytes,
      truncated: this.#stderrTruncated,
      capBytes: MAX_CHILD_STDERR_BYTES
    };
  }

  /**
   * I02-F2-3 / I02-F4. Every official startup announcement seen this run, in
   * arrival order. This started as "the sequence the P4 reply timing was derived
   * from"; after the reply's removal it is simply the zero-send claim's own
   * evidence, and E-PROBE-R3-P4 is a real run of it. No identifier value is
   * present: only the protocol constants `method` and `phase`, the numeric
   * `sequence`, and enum membership.
   */
  get startupFrames(): readonly StartupFrameSummary[] {
    return this.#startupFrames;
  }

  /**
   * I02-F3-3. Every inbound frame this run saw, in ARRIVAL ORDER, with the
   * official classification and whether it actually correlated to a pending
   * request. A report that says "the correlation is unproven" is only
   * actionable if the reader can see WHICH frames arrived and in what order —
   * a single error frame and a late success frame are different findings, and
   * the previous report could not tell them apart.
   */
  get frameLog(): readonly InboundFrameRecord[] {
    return this.#frameLog;
  }

  start(): void {
    if (this.#child !== null) throw new Error('NoSendStdioClient.start() called twice');
    const { env, report } = sanitizeEnv(process.env, {
      ...(this.#options.envExtra ?? {}),
      // Our own nonce: identity proof that the child we talk to is the child we
      // created. It is a random value, never a credential.
      ZCODE_COMPANION_PROBE_NONCE: this.identity.nonce
    });
    this.#envReport = report;
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd ?? process.cwd(),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.#child = child;
    this.#pid = typeof child.pid === 'number' ? child.pid : null;

    const stdout = child.stdout;
    if (stdout === null) {
      // CORRECTED ON REVIEW: the pre-review code threw here AFTER assigning
      // `this.#child`, so a child that spawned but produced no stdout pipe was
      // orphaned with nothing holding a reference able to reclaim it. Reclaim it
      // through the handle we just created, then fail.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      this.#child = null;
      throw new Error('child stdout is not a pipe');
    }
    stdout.on('data', (chunk) => this.#onBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')));
    stdout.on('end', () => this.#fail('EOF_WITH_PENDING', 'child stdout closed'));
    stdout.on('error', () => this.#fail('CHILD_ERROR', 'child stdout errored'));
    // I02-F2-2. stderr is a PIPE and nobody was reading it before this. That is
    // not a leak (a pipe with a small backlog is drained by the OS until it
    // fills) but it IS the reason a fatal child produced no reason at all:
    // P2/P3/P4 each reported "EOF_WITH_PENDING / child stdout closed" while the
    // actual text sat unread in this buffer. The bytes are kept as Buffers and
    // decoded once, on access, so a multi-byte glyph split across two reads
    // survives.
    child.stderr?.on('data', (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      this.#stderrBytes += buf.byteLength;
      const room = MAX_CHILD_STDERR_BYTES - (this.#stderrBytes - buf.byteLength);
      if (room <= 0) { this.#stderrTruncated = true; return; }
      if (buf.byteLength > room) { this.#stderrTruncated = true; this.#stderrChunks.push(buf.subarray(0, room)); return; }
      this.#stderrChunks.push(buf);
    });
    child.stdin?.on('error', () => { /* the child may exit before we finish writing */ });
    child.on('error', (err: Error) => this.#fail('CHILD_ERROR', `${err.name}: ${err.message}`));
    child.on('close', (code, signal) => {
      this.#exit = { code, signal };
      const err = new Error('child exited');
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) break;
        clearTimeout(waiter.timer);
        waiter.resolve({ kind: 'error', code: 'EOF_WITH_PENDING', detail: `child closed while awaiting ${waiter.method}`, dispatchOrdinal: this.#dispatchOrdinal });
      }
      while (this.#exitWaiters.length > 0) this.#exitWaiters.shift()?.({ code, signal });
      void err;
    });
  }

  /**
   * Writes one control-plane request, or refuses.
   *
   * I-3: BOTH paths now record. The refusal path increments
   * `modelDispatchAttempts` BEFORE it returns, so a caller that asks for a
   * dispatching method leaves a real, non-zero number behind. That is what makes
   * `assertNoModelDispatch()` capable of throwing at all.
   *
   * @throws ModelDispatchAttemptError for anything outside the allowlist — before any byte is written.
   */
  request(method: string, params: unknown, timeoutMs?: number): Promise<TransportOutcome> {
    if (this.#closed) return Promise.resolve({ kind: 'error', code: 'CHILD_ERROR', detail: 'client is closed', dispatchOrdinal: this.#dispatchOrdinal });
    if (this.#child === null) return Promise.resolve({ kind: 'error', code: 'CHILD_ERROR', detail: 'client not started', dispatchOrdinal: this.#dispatchOrdinal });
    if (classifyMethod(method) !== 'control') {
      // The increment that was missing before the REV4 review. It sits on the
      // refusal path deliberately: "we never called it" is not evidence, and a
      // counter that only moved on success could not tell a clean run from a
      // client that was never asked anything.
      this.#ledger.modelDispatchAttempts += 1;
      this.#ledger.refusedPotentiallyDispatching += 1;
      return Promise.reject(new ModelDispatchAttemptError(method));
    }
    // I02-F3-2. The frame is the OFFICIAL one, not the generic JSON-RPC one.
    // The `jsonrpc` member this used to carry is not in `qir` and `qir` is
    // `.strict()` (E-BUNDLE-021), so every frame written before this was
    // rejected by the official message union and answered with a fixed
    // 15-character diagnostic id instead of our own. Key ORDER follows the
    // schema declaration order for readability; JSON object order carries no
    // protocol meaning.
    const requestId = this.nextRequestId();
    const frame = buildOfficialRequestFrame(requestId, method, params);
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
    if (encoded.byteLength > this.limits.maxFrameBytes) {
      this.#fail('FRAME_TOO_LARGE', `outbound frame for ${method} is ${encoded.byteLength} bytes`);
      return Promise.resolve({ kind: 'error', code: 'FRAME_TOO_LARGE', detail: method, dispatchOrdinal: this.#dispatchOrdinal });
    }
    this.#ledger.controlFrames += 1;
    // I02-F2-3. The pre-write notice is a hook, not a `process.stderr.write`
    // inside this module: a library that logs to the host's terminal
    // uninvited is the thing being reviewed here. The line handed over is the
    // exact text that will be written, so what the operator sees is what the
    // child receives.
    this.#onControlWrite({ method, line: encoded.toString('utf8'), why: 'request' });
    this.#requestSeq += 1;
    return new Promise<TransportOutcome>((resolvePromise) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolvePromise({ kind: 'error', code: 'TIMEOUT', detail: `no response within ${timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms for ${method}`, dispatchOrdinal: this.#dispatchOrdinal });
      }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      // `expectId` is what makes F3-3 work: this waiter is satisfied ONLY by a
      // response whose id is exactly `requestId`.
      this.#waiters.push({ resolve: resolvePromise, timer, method, expectId: requestId });
      // I-3: the ONLY increment for `modelDispatch`. Everything written to a
      // child goes through this one function, and it asks `classifyMethod`
      // again at the write site rather than trusting the earlier gate — so if a
      // future edit ever encodes bytes for a non-control method, the counter
      // moves and `assertNoModelDispatch()` throws.
      if (classifyMethod(method) !== 'control') this.#ledger.modelDispatch += 1;
      this.#child?.stdin?.write(encoded);
    });
  }

  /**
   * I02-F2-3 added `#emitStartupReply` here — the single write of
   * `{"method":"startup/storagePathReady"}`, armed only by the doubly
   * acknowledged P4 path, counted in `controlFrames`, which is why P4
   * acceptance moved from 1 to 2.
   *
   * I02-F4 DELETED THE METHOD. Its three structural safeguards were real but
   * irrelevant once the conclusion changed: the handshake it answered belongs
   * to `app-server --prepare-storage` (E-BUNDLE-026) and this surface discards
   * id-less notifications by design (E-BUNDLE-023). A guard that makes an inert
   * write reachable is not a safety property, it is a delay. The replacement for
   * the guard is stronger: the method is off CONTROL_PLANE_METHODS, so
   * `request()` refuses it at the ordinary gate and counts the attempt, and the
   * client option that armed it no longer exists on the options type.
   */

  /** Awaits the next inbound frame, honouring the same waiter discipline. */
  nextFrame(timeoutMs?: number): Promise<TransportOutcome> {    if (this.#fatal !== null) {
      return Promise.resolve({ kind: 'error', code: this.#fatal, detail: this.#fatalDetail, dispatchOrdinal: this.#dispatchOrdinal });
    }
    const buffered = this.#ready.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ kind: 'ok', frame: buffered, dispatchOrdinal: this.#dispatchOrdinal });
    }
    return new Promise<TransportOutcome>((resolvePromise) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolvePromise({ kind: 'error', code: 'TIMEOUT', detail: `no inbound frame within ${timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms`, dispatchOrdinal: this.#dispatchOrdinal });
      }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      // A `nextFrame()` waiter is the PASSIVE observation path: it is
      // satisfied by the next frame of any shape, which is the whole point of
      // it. `expectId: null` is what distinguishes it from `request()`.
      this.#waiters.push({ resolve: resolvePromise, timer, method: '<inbound>', expectId: null });
    });
  }

  /**
   * Answers a reverse request.
   *
   * With the default policy every reverse method is refused with a JSON-RPC
   * error and counted.
   *
   * I-4. This method DOES write a frame to the child. A refusal is not a model
   * dispatch — it is a protocol-level error response that carries no work for
   * the runtime to execute — but it is bytes, and the old wording "this product
   * writes no frame" was false whenever the runtime asked for anything. The
   * write is now counted in `refusalFrames` so a report cannot imply otherwise,
   * and it is deliberately NOT counted in `controlFrames`, which means "requests
   * this product originated".
   */
  handleReverseRequest(frame: ProtocolFrame, extra: Readonly<Record<string, unknown>> = {}): 'refused' | 'served' {
    const method = typeof frame['method'] === 'string' ? (frame['method'] as string) : '';
    // Note on the `served` branch: under I02 it is unreachable, because
    // REFUSED_REVERSE_METHODS covers every known reverse method. It is kept only
    // so the ledger's two counters stay honest about what was attempted. It is
    // NOT a working "serve" capability and must not be read as one.
    const refuse = this.#refuseAllReverse || !REVERSE_REQUEST_METHODS.has(method) || REFUSED_REVERSE_METHODS.has(method);
    const id = frame['id'];
    // I02-F3-2. Same correction as `request()`: E-BUNDLE-024 shows the official
    // response/error frame is `{id, result}` / `{error, id}` with no `jsonrpc`
    // member and no other slots. The refusal still goes out — it is the whole
    // "never serve a reverse request" guarantee, and it is counted in
    // `refusalFrames` — but it now goes out in a shape the peer can parse.
    const payload = refuse
      ? { id: id ?? null, error: { code: -32601, message: `Companion does not serve reverse request "${method}"` } }
      : { id: id ?? null, result: extra };
    if (refuse) this.#ledger.refusedReverse += 1;
    else this.#ledger.servedReverse += 1;
    const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    if (encoded.byteLength > this.limits.maxFrameBytes) {
      this.#fail('FRAME_TOO_LARGE', `reverse response for ${method} is ${encoded.byteLength} bytes`);
      return refuse ? 'refused' : 'served';
    }
    this.#ledger.refusalFrames += 1;
    try {
      this.#child?.stdin?.write(encoded);
    } catch {
      /* the child may already be gone; the ledger count is what matters */
    }
    return refuse ? 'refused' : 'served';
  }

  /**
   * I-3. The zero-send assertion, now able to actually fail.
   *
   * It asserts on `modelDispatchAttempts` (a counter with a real increment on
   * the refusal path) as well as on `modelDispatch` (a counter with a real
   * increment at the write site). Before the REV4 review it read a variable that
   * nothing ever wrote, so it was a decoration and the phrase "measured twice
   * and independently" was an overstatement.
   *
   * A zero-send probe run must reach the end of its command with both at 0.
   * A test that deliberately exercises the refusal path is expected to see
   * `modelDispatchAttempts > 0` and must call `assertNoDispatchRefusedCleanly()`
   * there instead — that variant asserts the honest invariant: attempts may be
   * non-zero, but no dispatching frame was ever written.
   *
   * @throws when anything attempted a model dispatch.
   */
  assertNoModelDispatch(): void {
    const { modelDispatch, modelDispatchAttempts } = this.#ledger;
    if (modelDispatchAttempts !== 0 || modelDispatch !== 0) {
      throw new Error(
        `zero-send contract violated: ${modelDispatchAttempts} model-dispatch attempt(s), `
        + `${modelDispatch} frame(s) actually written to the child; both must be 0`
      );
    }
  }

  /**
   * I-3. For a run that deliberately tried dispatching methods and watched the
   * gate refuse every one of them. The only invariant here is that refusal
   * happened and that nothing was written.
   *
   * @throws when a dispatching frame actually reached the child.
   */
  assertNoDispatchRefusedCleanly(): void {
    if (this.#ledger.modelDispatch !== 0) {
      throw new Error(
        `zero-send contract violated: ${this.#ledger.modelDispatch} model-dispatching frame(s) were written to the child`
      );
    }
  }

  /** Bounded, idempotent teardown. Only this object's own handle is signalled. */
  async close(graceMs = 2000, forceMs = 4000): Promise<{ code: number | null; signal: NodeJS.Signals | null; stage: string; pendingWaiters: number }> {
    if (this.#closed) return { code: this.#exit?.code ?? null, signal: this.#exit?.signal ?? null, stage: 'already-closed', pendingWaiters: 0 };
    this.#closed = true;
    const child = this.#child;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.resolve({ kind: 'error', code: 'CHILD_ERROR', detail: 'client closed', dispatchOrdinal: this.#dispatchOrdinal });
    }
    if (child === null) return { code: null, signal: null, stage: 'never-started', pendingWaiters: 0 };
    try { child.stdout?.removeAllListeners('data'); child.stdout?.destroy(); } catch { /* already gone */ }
    try { child.stdin?.end(); } catch { /* already ended */ }

    /** @param {string} stage @param {number} budget */
    const settle = async (stage: string, budget: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stage: string; pendingWaiters: number }> => {
      if (this.#exit !== null) return { ...this.#exit, stage, pendingWaiters: this.#waiters.length };
      const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => this.#exitWaiters.push(r)),
        new Promise<null>((r) => { const t = setTimeout(() => r(null), budget); t.unref?.(); })
      ]);
      if (result === null) throw new Error(`child did not close within ${budget}ms (${stage})`);
      return { ...result, stage, pendingWaiters: this.#waiters.length };
    };

    try {
      return await settle('stdin-eof', graceMs);
    } catch { /* escalate to our own handle only */ }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return await settle('sigterm', forceMs);
    } catch { /* escalate to our own handle only */ }
    child.kill('SIGKILL');
    return settle('sigkill', forceMs);
  }

  /**
   * Records one official startup announcement. `phase` is printed because it is
   * a compile-time constant of the official enum and the whole observation is
   * stated in terms of it; `attemptId` and `databaseId` are never touched here,
   * so this adds no new disclosure surface to the value-free I-2 shape summary.
   *
   * I02-F4 removed the "and fires the reply at the derived trigger" half. What is
   * left is pure observation, which is the whole of what the zero-send claim
   * needs: E-PROBE-R3-P4 is this array, filled by a real run that wrote nothing.
   *
   * @param frame one parsed inbound frame
   */
  #observeStartupFrame(frame: ProtocolFrame): void {
    const method = frame['method'];
    if (typeof method !== 'string' || !method.startsWith('startup/')) return;
    const params = frame['params'];
    const record = typeof params === 'object' && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const sequence = typeof record['sequence'] === 'number' ? record['sequence'] : null;
    const phase = typeof record['phase'] === 'string' ? record['phase'] : null;
    this.#startupFrames.push({
      index: this.#framesSeen,
      methodName: method,
      sequence,
      phase,
      phaseIsOfficialEnumMember: phase !== null && OFFICIAL_PHASE_ENUM.includes(phase)
    });
  }

  #fail(code: FrameErrorCode, detail: string): void {    if (this.#fatal === null) this.#fatal = code;
    if (this.#fatalDetail === '') this.#fatalDetail = detail;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.resolve({ kind: 'error', code, detail, dispatchOrdinal: this.#dispatchOrdinal });
    }
  }

  /**
   * @param chunk raw stdout bytes
   *
   * CORRECTED ON REVIEW. The pre-review version appended the chunk, consumed the
   * FIRST newline, and then returned. Every later line in the same chunk was
   * pushed into `#pendingBytes` and never looked at again: a runtime that wrote
   * two frames in one `write()` lost the second one silently. The old code only
   * passed its fixtures because every fixture wrote one frame at a time, spaced
   * by a timer. The buffer is now kept contiguous and drained completely, so N
   * lines per chunk, N chunks per line, and multi-byte characters split across
   * either boundary all work.
   */
  #onBytes(chunk: Buffer): void {
    if (this.#fatal !== null) return;

    // Keep ONE contiguous head buffer. Splitting across many small buffers makes
    // "how many bytes into the current line are we" ambiguous; one buffer makes
    // it simply `head.length`.
    const head = this.#pendingBytes[0];
    this.#pendingBytes = head === undefined || head.byteLength === 0
      ? [chunk]
      : [Buffer.concat([head, chunk])];
    const buf = this.#pendingBytes[0] as Buffer;

    if (buf.byteLength > this.limits.maxBufferBytes) {
      this.#fail('BUFFER_TOO_LARGE', `concatenation buffer reached ${buf.byteLength} bytes`);
      return;
    }
    this.#pendingByteLength = buf.byteLength;

    let start = 0;
    for (;;) {
      const newline = buf.indexOf(0x0a, start);
      if (newline === -1) break;
      this.#consumeLine(buf.subarray(start, newline + 1));
      if (this.#fatal !== null) return;
      start = newline + 1;
    }

    // Whatever follows the last newline is the start of the next, possibly
    // incomplete, line. 0x0A cannot occur inside a multi-byte UTF-8 sequence, so
    // searching for it on raw bytes is safe and a CJK character split across two
    // chunks is still decoded correctly once the line completes.
    const remainder = buf.subarray(start);
    this.#pendingBytes = remainder.byteLength > 0 ? [remainder] : [];
    this.#pendingByteLength = remainder.byteLength;

    if (this.#pendingByteLength > this.limits.maxFrameBytes) {
      this.#fail('FRAME_TOO_LARGE', `incomplete frame reached ${this.#pendingByteLength} bytes without a newline`);
    }
  }

  /**
   * @param lineBytes one complete NDJSON line including its newline
   *
   * A fresh decoder per line: 0x0A can never fall inside a multi-byte sequence,
   * so a line boundary is always a character boundary, and a reused non-streaming
   * decoder could otherwise carry a partial sequence into the next line.
   */
  #consumeLine(lineBytes: Buffer): void {
    const bodyBytes = lineBytes.subarray(0, lineBytes.byteLength - 1);
    if (bodyBytes.byteLength > this.limits.maxFrameBytes) {
      this.#fail('FRAME_TOO_LARGE', `frame of ${bodyBytes.byteLength} bytes exceeds ${this.limits.maxFrameBytes}`);
      return;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
    } catch (e) {
      this.#fail('MALFORMED_JSON', `frame is not decodable UTF-8: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (text.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.#fail('MALFORMED_JSON', e instanceof Error ? e.message : String(e));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#fail('MALFORMED_JSON', 'frame is not a JSON object');
      return;
    }
    const frame = parsed as ProtocolFrame;
    this.#framesSeen += 1;
    const metadata = frame['params'] ?? frame['result'] ?? frame['error'];
    if (metadata !== undefined && metadata !== null) {
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(metadata) ?? '', 'utf8');
      } catch (e) {
        // Never let a sizing failure escape a stream handler.
        this.#fail('MALFORMED_JSON', `metadata could not be sized: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (size > this.limits.maxMetadataBytes) {
        this.#fail('METADATA_TOO_LARGE', `metadata blob of ${size} bytes exceeds ${this.limits.maxMetadataBytes}`);
        return;
      }
    }
    if (typeof frame['method'] === 'string' && frame['id'] !== undefined) {
      // A reverse request: refuse it, count it, and do not answer with work.
      // I02-F3-3: it is still LOGGED first, in order and classified, so a run
      // whose wait ended for some other reason can show that a server->client
      // request arrived in the middle of it. It can never satisfy a `request()`
      // waiter, because it is not a response.
      this.#frameLog.push({
        index: this.#framesSeen,
        kind: 'request',
        methodName: frame['method'] as string,
        hasId: true,
        idType: jsonTypeOf(frame['id']),
        idStringLength: typeof frame['id'] === 'string' ? (frame['id'] as string).length : null,
        correlatedToRequest: false,
        evaluatedAgainstMethod: null
      });
      this.handleReverseRequest(frame);
      return;
    }
    // I02-F2-3. The startup sequence is recorded, and the reply is emitted at
    // the derived trigger point. This runs BEFORE the frame is queued or handed
    // to a waiter, so the acknowledgement is on the wire no later than the
    // moment the trigger is observed.
    this.#observeStartupFrame(frame);

    // I02-F3-3. Record EVERY frame, in order, with its official classification,
    // before deciding which waiter (if any) it may satisfy.
    const kind = classifyInboundFrame(frame);
    /** @type {InboundFrameRecord} */
    const record: InboundFrameRecord = {
      index: this.#framesSeen,
      kind,
      methodName: typeof frame['method'] === 'string' ? (frame['method'] as string) : null,
      hasId: frame['id'] !== undefined,
      idType: jsonTypeOf(frame['id']),
      idStringLength: typeof frame['id'] === 'string' ? (frame['id'] as string).length : null,
      correlatedToRequest: false,
      evaluatedAgainstMethod: null
    };
    this.#frameLog.push(record);

    // I02-F3-3. Waiter selection. A `request()` waiter is satisfied ONLY by a
    // response whose id is strictly the id we sent; a `nextFrame()` waiter is
    // satisfied by anything. The pre-fix code took `this.#waiters.shift()`
    // unconditionally, so the FIRST frame of ANY shape ended the wait — which is
    // why one `{"id":"invalid-message"}` diagnostic was reported as a terminal
    // "correlation unproven" verdict with no possibility of a later answer.
    //
    // `evaluatedAgainstMethod` is recorded even when the frame is REJECTED, so
    // the log can say "this arrived while runtime/capabilities was pending and
    // did not match it" rather than leaving the reader to infer it.
    const isResponse = kind === 'response' || kind === 'error_response';
    /** @type {number} index of a request waiter whose id this frame satisfies */
    let matchedIndex = -1;
    for (let i = 0; i < this.#waiters.length; i++) {
      const candidate = this.#waiters[i];
      if (candidate === undefined || candidate.expectId === null) continue;
      if (isResponse && frame['id'] === candidate.expectId) { matchedIndex = i; break; }
    }
    const pendingRequest = this.#waiters.find((w) => w.expectId !== null);
    const passiveIndex = matchedIndex >= 0 ? -1 : this.#waiters.findIndex((w) => w.expectId === null);
    /** @type {number} */
    let waiterIndex = matchedIndex >= 0 ? matchedIndex : passiveIndex;
    this.#frameLog[this.#frameLog.length - 1] = {
      ...record,
      correlatedToRequest: matchedIndex >= 0,
      evaluatedAgainstMethod: pendingRequest === undefined ? null : pendingRequest.method
    };
    if (waiterIndex >= 0) {
      const waiter = this.#waiters.splice(waiterIndex, 1)[0];
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#dispatchOrdinal += 1;
        waiter.resolve({ kind: 'ok', frame, dispatchOrdinal: this.#dispatchOrdinal });
        return;
      }
    }
    // No waiter wanted it. It stays observable in the frame log — an error frame
    // that arrived while nothing was pending is exactly the kind of fact the
    // F3-1 diagnostic values exist to explain.
    this.#ready.push(frame);
  }
}

/** Convenience factory so a caller cannot forget the nonce. */
export function makeNonce(): string {
  return createHash('sha256')
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 32);
}

/* ================================================================== *
 * 4b. Frame shape summary — I-2
 * ================================================================== */

export type JsonTypeName = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'undefined';

export interface FieldShape {
  /** The SCHEMA KEY. Field names are not values and are always safe to print. */
  readonly name: string;
  readonly type: JsonTypeName;
  /** UTF-16 code-unit length. Present for `string` only. NEVER the content. */
  readonly stringLength?: number;
  /** UTF-8 byte length. Present for `string` only. NEVER the content. */
  readonly byteLength?: number;
  /** Present for `array` only. */
  readonly arrayLength?: number;
  /** Present for `object` only: how many direct fields it has. */
  readonly fieldCount?: number;
  /**
   * For a field the OFFICIAL schema constrains to a literal (today only
   * `schemaVersion`), whether the observed value equals that literal. The
   * literal itself is not printed, only whether the observation matched, which
   * is the part a machine can assert on.
   */
  readonly matchesOfficialLiteral?: boolean;
  /**
   * For a field the official schema constrains to an enum, the NAME of that
   * enum (e.g. `databaseKind`) plus whether the observed value is a member. The
   * member itself is NEVER printed — only "is a member", which is exactly what
   * the P3 acceptance criterion needs.
   */
  readonly officialEnum?: string;
  readonly isOfficialEnumMember?: boolean;
  /** One level of nesting, so `migration` inside `storageState` is visible. */
  readonly fields?: readonly FieldShape[];
}

/** Official literal constraints, read verbatim from E-BUNDLE-016. */
const OFFICIAL_LITERAL_CONSTRAINTS: Readonly<Record<string, unknown>> = { schemaVersion: 1 };

/** Official enum constraints, read verbatim from E-BUNDLE-016. */
const OFFICIAL_ENUM_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
  databaseKind: ['session', 'tasks-index'],
  phase: OFFICIAL_PHASE_ENUM
};

/**
 * I02-F3-1. Protocol-layer diagnostic values, exposed under the coordinator's
 * ruling and ONLY for a JSON-RPC RESPONSE to a request this product sent.
 *
 * WHY THIS EXISTS. Four probe rounds produced a bare "the frame answered did not
 * carry the request id; the correlation is unproven", because the value-free
 * shape summary hid the one field that explains everything: the error's `code`,
 * `message` and zod `issues`. F3-2 identified the frame statically, but a reader
 * of a future run must be able to identify it from the run itself.
 *
 * WHAT IS EXPOSED, and why each item is not a secret:
 *   `code`    a protocol constant (-32600, -32601, -32602, -32022 …).
 *   `message` a fixed protocol string, not user data.
 *   `issues`  zod's validator diagnostics: `path` (the schema field path),
 *             `code` (e.g. "unrecognized_keys") and `message`. Field paths and
 *             validator codes, never field VALUES.
 *   `id`      either this product's own id ("c1", "c2" …) or a server-generated
 *             reason literal. E-BUNDLE-022 shows the second case is a fixed
 *             token, which is precisely the fact that has to be publishable.
 *
 * WHAT IS STILL NEVER EXPOSED, by construction and by test:
 *   any `params` value, any `result` value, any secret-shaped key anywhere.
 * The last one is not a promise: `errorValues` is passed through `redact()`
 * here, and the whole report is passed through `redact()` again by the CLI, so
 * the redaction stacks.
 */
/** One reduced zod issue. Field NAMES and validator text only, never a value. */
export interface ErrorIssueDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  /**
   * Field names the validator rejected, when it named any. zod reports
   * `unrecognized_keys` with a `keys` array, and that array is the single most
   * useful thing in a message rejection: it is what named the offending
   * `jsonrpc` member in the R2 failure.
   */
  readonly keys: readonly string[];
  /**
   * The per-branch issues of an `invalid_union` issue, flattened. The official
   * `qHt` union has four branches and its top-level issue is a single
   * `invalid_union` with `message:"Invalid input"`, so without this the
   * diagnostic would say nothing about what was wrong. Field names and
   * validator codes only — a branch issue has no value either.
   */
  readonly branches: readonly { code: string; path: string; message: string; keys: readonly string[] }[];
}

export interface ErrorDiagnosticValues {
  /** The frame's `id` value. Our own request id, or the server's reason literal. */
  readonly idValue: string | number | null;
  readonly idType: JsonTypeName;
  /** `error.code`, or null when the frame carries no `error`. */
  readonly code: number | null;
  /** `error.message`, or null when the frame carries no `error`. */
  readonly message: string | null;
  /** `error.data.issues[]`, each reduced to path / code / message. */
  readonly issues: readonly ErrorIssueDiagnostic[];
  /**
   * I02-F3-2. Total number of branch issues found under `errors[].*` across all
   * issues, and how many were published. The official `qHt` union has four
   * branches, so ONE `invalid_union` issue carries up to four branch arrays —
   * and the offending key is only named inside them. A run that published 0 of
   * them would report "Invalid input", which is exactly the kind of contentless
   * diagnostic this whole change exists to eliminate.
   */
  readonly nestedBranchIssuesFound: number;
  readonly nestedBranchIssuesPublished: number;
  /** True when `error.data` had a member other than `issues`. */
  readonly dataHadOtherMembers: boolean;
  /** Always states, in the payload itself, that redaction is stacked. */
  readonly redactionApplied: 'module-redact()+cli-redact()';
}

export interface FrameShapeOptions {
  /**
   * I02-F3-1. Must be `true` for ANY value to appear in `errorValues`. It is
   * set at exactly one call site, the P4 readback, which is the only path the
   * coordinator's ruling covers. Every other caller — P2, P3, the contract
   * suite's value-leak tests — leaves it unset and keeps getting
   * `errorValues: null`.
   */
  readonly exposeProtocolDiagnostics?: boolean;
}

export interface FrameShapeSummary {
  /** Top-level key NAMES of the frame, in order. */
  readonly topLevelKeys: readonly string[];
  /**
   * The VALUE of the `method` field. This is a protocol constant from the
   * official method map, not user data, and printing it is the whole point: it
   * is how P3 identifies WHICH of the three E-BUNDLE-014 union variants arrived.
   */
  readonly methodName: string | null;
  /** The value of `jsonrpc` (expected "2.0"). A constant, not user data. */
  readonly jsonrpc: string | null;
  /** `id` described by type and length only. The value is never printed. */
  readonly idType: JsonTypeName;
  readonly idStringLength: number | null;
  readonly hasParams: boolean;
  readonly hasResult: boolean;
  readonly hasError: boolean;
  /** Shape of `params`, or null when absent. */
  readonly paramsShape: readonly FieldShape[] | null;
  /** Shape of `result`, or null when absent. */
  readonly resultShape: readonly FieldShape[] | null;
  /**
   * Shape of `error`, or null when absent.
   */
  readonly errorShape: readonly FieldShape[] | null;
  /**
   * I02-F3-1. `null` unless the caller passed
   * `{exposeProtocolDiagnostics:true}`, which only the P4 readback does. See
   * `ErrorDiagnosticValues` for exactly what may appear and for why.
   */
  readonly errorValues: ErrorDiagnosticValues | null;
  /**
   * Explicit statement of the redaction rule, carried in the payload so that a
   * reader of the report cannot mistake this for a raw frame dump.
   */
  readonly valuesIncluded: 'none — field names, types, lengths and enum membership only'
    | 'protocol diagnostics only — error code/message, zod issue path/code/message, and the frame id; no params or result value (P4 path, coordinator ruling F3-1)';
}

/** @param value @returns {JsonTypeName} */
function jsonTypeOf(value: unknown): JsonTypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as JsonTypeName;
}

/**
 * @param name @param value @param depth @returns {FieldShape}
 */
function shapeOfField(name: string, value: unknown, depth: number): FieldShape {
  const type = jsonTypeOf(value);
  /** @type {Record<string, unknown>} */
  const shape: Record<string, unknown> = { name, type };

  if (typeof value === 'string') {
    shape['stringLength'] = value.length;
    shape['byteLength'] = Buffer.byteLength(value, 'utf8');
  } else if (type === 'array') {
    const arr = value as readonly unknown[];
    shape['arrayLength'] = arr.length;
  } else if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    shape['fieldCount'] = entries.length;
    if (depth > 0) shape['fields'] = entries.map(([k, v]) => shapeOfField(k, v, depth - 1));
  }

  const literal = OFFICIAL_LITERAL_CONSTRAINTS[name];
  if (literal !== undefined) shape['matchesOfficialLiteral'] = value === literal;

  const enumMembers = OFFICIAL_ENUM_CONSTRAINTS[name];
  if (enumMembers !== undefined) {
    shape['officialEnum'] = name;
    shape['isOfficialEnumMember'] = typeof value === 'string' && enumMembers.includes(value);
  }

  return shape as unknown as FieldShape;
}

/**
 * I02-F3-1. Reduces `error.data.issues[]` to path / code / message ONLY.
 *
 * A zod issue is `{code, path, message, …}`; the `path` is an array of keys
 * into the message, `code` is a validator identifier and `message` is a fixed
 * validator sentence. None of those three is a value the peer sent, which is
 * why the coordinator's ruling permits them while forbidding `params` values.
 *
 * @param errorValue the frame's `error` member
 * @returns the diagnostic block, or null when there is no `error`
 */
function buildErrorDiagnosticValues(frame: ProtocolFrame): ErrorDiagnosticValues {
  const idValue = frame['id'];
  const idText = (): string | number | null => (typeof idValue === 'string' || typeof idValue === 'number' ? idValue : null);
  const errorValue = frame['error'];
  if (typeof errorValue !== 'object' || errorValue === null || Array.isArray(errorValue)) {
    return {
      idValue: idText(),
      idType: jsonTypeOf(idValue),
      code: null,
      message: null,
      issues: [],
      nestedBranchIssuesFound: 0,
      nestedBranchIssuesPublished: 0,
      dataHadOtherMembers: false,
      redactionApplied: 'module-redact()+cli-redact()'
    };
  }
  const err = errorValue as Record<string, unknown>;
  const dataValue = err['data'];
  const dataIsObject = typeof dataValue === 'object' && dataValue !== null && !Array.isArray(dataValue);
  /** @type {ErrorIssueDiagnostic[]} */
  const issues: ErrorIssueDiagnostic[] = [];
  let nestedFound = 0;
  let nestedPublished = 0;

  /**
   * @param rec one raw zod issue
   * @returns the reduced issue, or null when it carries nothing printable
   */
  const reduce = (rec: Record<string, unknown>): ErrorIssueDiagnostic | null => {
    const rawPath = rec['path'];
    // The path is key NAMES. `String()` on a key and on a scalar value are
    // indistinguishable, so a length cap is applied as a second guard and the
    // joined form is what a reader actually needs.
    const pathText = Array.isArray(rawPath) ? rawPath.map((p) => String(p).slice(0, 64)).join('.') : '';
    const codeText = typeof rec['code'] === 'string' ? rec['code'] : '';
    const messageText = typeof rec['message'] === 'string' ? rec['message'] : '';
    const rawKeys = rec['keys'];
    const keys = Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === 'string').slice(0, 8) : [];
    /** @type {{code:string,path:string,message:string,keys:readonly string[]}[]} */
    const branches: { code: string; path: string; message: string; keys: readonly string[] }[] = [];
    const rawErrors = rec['errors'];
    if (Array.isArray(rawErrors)) {
      for (const branch of rawErrors) {
        if (!Array.isArray(branch)) continue;
        for (const sub of branch) {
          if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) continue;
          nestedFound += 1;
          if (branches.length >= MAX_NESTED_BRANCH_ISSUES) continue;
          const subRec = sub as Record<string, unknown>;
          const subPath = Array.isArray(subRec['path'])
            ? (subRec['path']).map((p) => String(p).slice(0, 64)).join('.')
            : '';
          const subKeys = Array.isArray(subRec['keys'])
            ? (subRec['keys']).filter((k): k is string => typeof k === 'string').slice(0, 8)
            : [];
          branches.push({
            code: typeof subRec['code'] === 'string' ? subRec['code'].slice(0, 64) : '',
            path: subPath.slice(0, 128),
            message: typeof subRec['message'] === 'string' ? subRec['message'].slice(0, 256) : '',
            keys: subKeys
          });
          nestedPublished += 1;
        }
      }
    }
    if (pathText === '' && codeText === '' && messageText === '' && keys.length === 0 && branches.length === 0) return null;
    return {
      path: pathText.slice(0, 128),
      code: codeText.slice(0, 64),
      message: messageText.slice(0, 256),
      keys,
      branches
    };
  };

  if (dataIsObject) {
    const rawIssues = (dataValue as Record<string, unknown>)['issues'];
    if (Array.isArray(rawIssues)) {
      for (const issue of rawIssues.slice(0, 16)) {
        if (typeof issue !== 'object' || issue === null || Array.isArray(issue)) continue;
        const reduced = reduce(issue as Record<string, unknown>);
        if (reduced !== null) issues.push(reduced);
      }
    }
  }
  const otherMembers = dataIsObject
    ? Object.keys(dataValue as Record<string, unknown>).filter((k) => k !== 'issues')
    : [];
  const block: ErrorDiagnosticValues = {
    idValue: idText(),
    idType: jsonTypeOf(idValue),
    code: typeof err['code'] === 'number' ? err['code'] : null,
    message: typeof err['message'] === 'string' ? err['message'] : null,
    issues,
    nestedBranchIssuesFound: nestedFound,
    nestedBranchIssuesPublished: nestedPublished,
    dataHadOtherMembers: otherMembers.length > 0,
    redactionApplied: 'module-redact()+cli-redact()'
  };
  // I02-F3-1: "redact() 照常叠加". Applied HERE as well as at the CLI, so the
  // guarantee does not depend on the caller remembering. redact() replaces a
  // secret-SHAPED KEY's value with a marker, so a hypothetical `error.data.
  // {apiKey:…}` member could not ride out through `issues` or `message`.
  return redact(block).value;
}

/** I02-F3-2. Cap on flattened `invalid_union` branch issues, so a hostile or
 *  deeply nested validator error cannot inflate the report. */
const MAX_NESTED_BRANCH_ISSUES = 12;

/**
 * I-2. Turns one observed frame into a machine-evaluable SCHEMA SHAPE.
 *
 * The defect this replaces: the CLI printed `Object.keys(first.frame)` and
 * nothing else, so a P3 run produced only
 * `frameKeys: ["jsonrpc","id","method","params"]` — the top-level key NAMES. The
 * executor could not tell which of the three official startup variants had
 * arrived and could not check a single one of the E-BUNDLE-014/016 constraints,
 * so P3 could not produce the evidence it claimed to produce.
 *
 * WHAT IS IN: key names, JSON types, string lengths (code units AND bytes),
 * array lengths, field counts, which official enum a field belongs to, whether
 * that value is a member of it, whether a literal constraint matched, the
 * `method` and `jsonrpc` values, and one level of nesting.
 *
 * WHAT IS NEVER IN: any actual value. A `path` is reported as
 * `{name:"path",type:"string",stringLength:57,byteLength:57}` — never its text.
 * `attemptId`, `databaseId` and the JSON-RPC `id` are treated the same way. An
 * enum member is reported as `isOfficialEnumMember:true` and never as which
 * member, because "which member" is the value. The method name IS printed
 * because it is a compile-time constant of the official protocol and identifying
 * the union variant is the acceptance criterion; that is a deliberate, bounded
 * exception, not a general one.
 *
 * @param frame one parsed inbound frame
 * @param options I02-F3-1. `exposeProtocolDiagnostics` is the ONLY way a value
 *   enters this structure, and it is set at exactly one call site.
 * @returns the shape summary
 */
export function describeFrameShape(frame: ProtocolFrame, options: FrameShapeOptions = {}): FrameShapeSummary {
  const methodValue = frame['method'];
  const idValue = frame['id'];
  const jsonrpcValue = frame['jsonrpc'];
  const expose = options.exposeProtocolDiagnostics === true;

  /** @param v @returns {readonly FieldShape[] | null} */
  const objectShape = (v: unknown): readonly FieldShape[] | null => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return Object.entries(v as Record<string, unknown>).map(([k, val]) => shapeOfField(k, val, 1));
  };

  return {
    topLevelKeys: Object.keys(frame),
    methodName: typeof methodValue === 'string' ? methodValue : null,
    jsonrpc: typeof jsonrpcValue === 'string' ? jsonrpcValue : null,
    idType: jsonTypeOf(idValue),
    idStringLength: typeof idValue === 'string' ? idValue.length : null,
    hasParams: frame['params'] !== undefined,
    hasResult: frame['result'] !== undefined,
    hasError: frame['error'] !== undefined,
    paramsShape: objectShape(frame['params']),
    resultShape: objectShape(frame['result']),
    errorShape: objectShape(frame['error']),
    errorValues: expose ? buildErrorDiagnosticValues(frame) : null,
    valuesIncluded: expose
      ? 'protocol diagnostics only — error code/message, zod issue path/code/message, and the frame id; no params or result value (P4 path, coordinator ruling F3-1)'
      : 'none — field names, types, lengths and enum membership only'
  };
}

/* ================================================================== *
 * 5. Billing evidence map
 * ================================================================== */

export type BillingClass = 'subscription' | 'promotion' | 'metered_api' | 'unknown';

export interface BillingEvidenceLink {
  readonly from: string;
  readonly to: string;
  readonly status: 'established' | 'unknown';
  readonly evidence: readonly OfficialEvidenceRef[];
  readonly note: string;
}

export interface BillingEvidenceMap {
  readonly links: readonly BillingEvidenceLink[];
  /** A class may be claimed only when every link is established. */
  readonly resolvedClass: BillingClass;
  readonly sendAllowed: false;
  readonly notes: readonly string[];
}

/**
 * The chain the product needs before a single request may be sent.
 * Today link 1 does not exist, so the whole map is unknown and sending is refused.
 */
export function buildBillingEvidenceMap(): BillingEvidenceMap {
  return {
    links: [
      {
        from: '官方可指认计费字段 (per-model billing field)',
        to: '官方可指认计费政策 (named billing policy)',
        status: 'unknown',
        evidence: cite('E-BUNDLE-009', 'E-BUNDLE-010'),
        note:
          'The only billing-shaped official schema found describes OFF-PEAK / AUTOMATION task outcomes, and its quota text is explicitly about idle-time task quota. It is not a per-model chat billing field, and a directory entry name is never billing evidence.'
      },
      {
        from: '官方可指认计费政策',
        to: '当前账号资格 (entitlement for the signed-in account)',
        status: 'unknown',
        evidence: cite('E-BUNDLE-001', 'E-BUNDLE-007'),
        note: 'No official, read-only, zero-send method returns a subscription entitlement for the current account. `permission.mode` is a run permission, not an entitlement.'
      },
      {
        from: '当前账号资格',
        to: 'provider / model 精确读回',
        status: 'unknown',
        evidence: cite('E-BUNDLE-001'),
        note: 'No zero-send catalogue readback was found, so provider and modelId cannot be taken verbatim. They may not be guessed or concatenated.'
      },
      {
        from: 'provider / model 精确读回',
        to: '计费类与有效期 (billing class + validity window)',
        status: 'unknown',
        evidence: cite('E-BUNDLE-010'),
        note: 'Validity window and promotion expiry have no official source. A promotion appearing in a catalogue is not an active promotion.'
      }
    ],
    resolvedClass: 'unknown',
    sendAllowed: false,
    notes: [
      'A missing link makes the whole map `unknown`; `unknown` is never sendable.',
      'metered_api is never sendable in this product under any circumstances.',
      'The presence of an `apiKey`-shaped field name in metadata is not itself evidence of extra billing, but that value is never exported, never logged and never decrypted. The reverse request that would hand the runtime MCP/runtime auth headers is refused by default (see REFUSED_REVERSE_METHODS).'
    ]
  };
}

/* ================================================================== *
 * 6. Redaction
 * ================================================================== */

const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|credential|cookie|authorization|bearer|private_key|license_key)/i;

export interface RedactionResult<T> {
  readonly value: T;
  /** Names only. Values are never echoed, not even in truncated form. */
  readonly redactedKeys: readonly string[];
}

/**
 * Deep-redacts a value before it is printed, logged or written to a report.
 * Secret-shaped keys are replaced by a marker; long strings are truncated.
 */
export function redact<T>(input: T, maxStringLength = 512): RedactionResult<T> {
  const redactedKeys = new Set<string>();

  /** @param value @param path */
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…[+${value.length - maxStringLength} chars]` : value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (typeof value === 'object' && value !== null) {
      /** @type {Record<string, unknown>} */
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(key)) {
          redactedKeys.add(path === '' ? key : `${path}.${key}`);
          out[key] = '[REDACTED]';
          continue;
        }
        out[key] = walk(v, path === '' ? key : `${path}.${key}`);
      }
      return out;
    }
    return value;
  };

  return { value: walk(input, '') as T, redactedKeys: [...redactedKeys].sort() };
}

/* ================================================================== *
 * 7. Report assembly
 * ================================================================== */

export interface ProbeReport {
  readonly generatedAtUtc: string;
  readonly evidencePin: typeof OFFICIAL_RUNTIME_EVIDENCE_PIN;
  readonly capabilities: readonly CapabilityRecord[];
  readonly counts: {
    readonly total: number;
    readonly unknown: number;
    readonly mechanismVerified: number;
    readonly behaviourVerified: number;
    readonly blocked: number;
  };
  readonly billing: BillingEvidenceMap;
  readonly ledger: SendLedger | null;
  /** Never true in this build. Real behavioural evidence requires a real run. */
  readonly runtimeReady: false;
  readonly blockingSummary: readonly string[];
}

/** @param ledger optional transport ledger, when a transport was exercised */
export function buildProbeReport(ledger: SendLedger | null = null): ProbeReport {
  const capabilities = CAPABILITY_MATRIX;
  return {
    generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    evidencePin: OFFICIAL_RUNTIME_EVIDENCE_PIN,
    capabilities,
    counts: {
      total: capabilities.length,
      unknown: capabilities.filter((c) => c.state === 'unknown').length,
      mechanismVerified: capabilities.filter((c) => c.state === 'mechanism_verified').length,
      behaviourVerified: behaviourVerifiedCount(),
      blocked: capabilities.filter((c) => c.state === 'blocked').length
    },
    billing: buildBillingEvidenceMap(),
    ledger,
    runtimeReady: false,
    blockingSummary: blockingCapabilities().map((c) => `${c.id}: ${c.title}`)
  };
}
