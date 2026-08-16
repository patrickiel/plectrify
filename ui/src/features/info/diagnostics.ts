/** The environment report the About dialog shows and copies, so a bug report
    arrives with the facts already in it instead of a round of questions.

    Two rules run through the whole file:

    - Never invent a value. A field the engine has not reported reads `—`. A
      guessed sample rate, or a zero XRun count that really means "this driver
      cannot count them", is worse than an admitted gap.
    - Nothing the user typed, and no file paths. Plugin and audio-device
      identities are in, because they are what actually breaks; rig, scene, lane
      and module names are the user's, and user-profile paths carry their
      account name on both OSes. The report is written to be pasted into a
      public issue.

    It is built as data and serialised separately, so the rows on screen and the
    text on the clipboard cannot drift apart. */

import { laneName } from '../../lib/engine/routing';
import { formatRamMb } from '../status/formatStats';
import type { PluginScanState } from '../../lib/engine/EngineBridge';
import type {
  AppInfo,
  AppSettings,
  BlacklistedPlugin,
  EngineBusyState,
  PluginInfo,
  RackModule,
  RoutingState,
  StatusState,
} from '../../lib/engine/types';
import type { BrowserFacts } from './browserFacts';

export interface DiagRow {
  label: string;
  value: string;
}

export interface DiagSection {
  title: string;
  rows: DiagRow[];
}

export interface DiagReport {
  sections: DiagSection[];
}

/** Everything the report is made of. A plain bag of state the caller already
    holds — keeping the builder a pure function of its input is what makes the
    whole report testable without an engine or a DOM. */
export interface DiagnosticsInput {
  info: AppInfo;
  status: StatusState;
  rack: RackModule[];
  routing: RoutingState;
  scan: PluginScanState;
  /** Every plugin the scan knows about, and every file it refuses to load.
      Both are listed by name — that is the point of the section — but a
      blacklist entry's path never is; it is under the user's account. */
  plugins: PluginInfo[];
  blacklisted: BlacklistedPlugin[];
  busy: EngineBusyState;
  settings: AppSettings;
  browser: BrowserFacts;
  /** The UI bundle's own provenance (see lib/buildStamp.ts). */
  ui: { buildStamp: string; commit: string };
  /** Sizes of the user's library. Counts only — the names are theirs. */
  library: { rigs: number; scenes: number };
}

const DASH = '—';

const dash = (value: string | undefined) => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? DASH : trimmed;
};

/** Joins the parts of a composite value, dropping the ones that are missing —
    so a row degrades one fact at a time instead of all at once. */
const facts = (...parts: (string | number | false | null | undefined)[]) => {
  const kept = parts
    .filter(
      (part): part is string | number => part !== false && part !== null && part !== undefined,
    )
    .map((part) => String(part).trim())
    .filter((part) => part !== '');
  return kept.length === 0 ? DASH : kept.join(' · ');
};

const count = (n: number, singular: string) => `${n} ${n === 1 ? singular : `${singular}s`}`;

const positive = (n: number | undefined): n is number => typeof n === 'number' && n > 0;

/** Samples as milliseconds at the running rate — the unit latency is actually
    judged in. Silent when the rate is unknown, rather than dividing by zero. */
const millis = (samples: number, sampleRate: number) =>
  positive(sampleRate) ? `${((samples / sampleRate) * 1000).toFixed(1)} ms` : undefined;

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "Mock Amp 2.1.0" — the plugin's own name and the version it reports. */
function moduleLabel(module: RackModule): string {
  const version = (module.pluginVersion ?? '').trim();
  return version === '' ? module.name : `${module.name} ${version}`;
}

/** The chain in signal order, with parallel groups as bracketed lanes:
    `Amp 2.1 → [A: Drive 1.0 | B: (empty)] → Reverb 3.2`.

    Lanes are labelled by position (A, B, C…) through `laneName`, never by
    `LaneMix.name` — that one is user-typed. */
function formatChain(rack: RackModule[], routing: RoutingState): string {
  if (rack.length === 0) return 'empty';

  const serial = rack.filter((module) => !module.laneId);
  const groups = [...routing.groups].sort((a, b) => a.position - b.position);
  const parts: string[] = [];

  const emitGroupsAt = (position: number) => {
    for (const group of groups.filter((candidate) => candidate.position === position)) {
      const lanes = group.lanes.map((lane, index) => {
        const modules = rack.filter((module) => module.laneId === lane.id).map(moduleLabel);
        const body = modules.length === 0 ? '(empty)' : modules.join(' → ');
        return `${laneName(index)}: ${body}`;
      });
      // An exclusive switch means only one lane is actually audible, which
      // changes what the report is describing.
      const active = group.activeLaneId
        ? ` switched to ${laneName(group.lanes.findIndex((lane) => lane.id === group.activeLaneId))}`
        : '';
      parts.push(`[${lanes.join(' | ')}]${active}`);
    }
  };

  serial.forEach((module, index) => {
    emitGroupsAt(index);
    parts.push(moduleLabel(module));
  });
  // Groups sitting after the last serial module (including a fully-split rack).
  for (let position = serial.length; position <= (groups.at(-1)?.position ?? -1); position += 1)
    emitGroupsAt(position);

  return parts.length === 0 ? 'empty' : parts.join(' → ');
}

function appSection(input: DiagnosticsInput): DiagSection {
  const { info, status, ui, browser } = input;
  const build = info.buildInfo;
  const isMock = info.build === 'Mock';

  const commit = build?.commit?.trim() ?? '';
  const uiCommit = ui.commit.trim();

  return {
    title: 'App',
    rows: [
      {
        label: 'Version',
        // One value, not two facts: the build config qualifies the version.
        value: `${dash(info.version)}${info.build.trim() === '' ? '' : ` (${info.build.trim()})`}`,
      },
      {
        label: 'Commit',
        value: commit === '' ? DASH : `${commit}${build?.dirty ? ' (dirty)' : ''}`,
      },
      { label: 'Built', value: dash(build?.builtAt) },
      { label: 'Compiler', value: dash(build?.compiler) },
      { label: 'Engine', value: dash(info.juceVersion) },
      {
        label: 'UI bundle',
        value: facts(
          dash(ui.buildStamp),
          uiCommit,
          // The exe serves whatever ui/dist is on disk, so the two can disagree
          // — and that mismatch explains bugs that no source read can.
          commit !== '' && uiCommit !== '' && uiCommit !== commit ? "doesn't match the app" : false,
        ),
      },
      {
        label: 'Renderer',
        // The label names what the number belongs to: the WebView2 runtime on
        // Windows (a separately-updated component), the OS's WebKit on macOS,
        // and plain Chromium when the mock runs in a browser.
        value:
          browser.webViewVersion === ''
            ? DASH
            : browser.rendererFamily === 'webkit'
              ? `WebKit ${browser.webViewVersion}`
              : `${isMock ? 'Chromium' : 'WebView2'} ${browser.webViewVersion}`,
      },
      {
        label: 'Formats',
        // "no ASIO" is a Windows fact — its absence there explains a missing
        // device type. On macOS ASIO does not exist, so stating it would be
        // noise in every report.
        value: build
          ? facts(
              build.vst3 ? 'VST3' : 'no VST3',
              info.platform !== 'macos' && (build.asio ? 'ASIO built in' : 'no ASIO'),
            )
          : DASH,
      },
      { label: 'Uptime', value: formatUptime(status.uptimeSeconds) },
    ],
  };
}

function systemSection(input: DiagnosticsInput): DiagSection {
  const { info, status, browser } = input;
  const system = info.system;
  const ramTotalMb = system?.ramTotalMb ?? status.systemRamTotalMb;

  return {
    title: 'System',
    rows: [
      {
        label: 'OS',
        value: facts(dash(info.os), system && (system.os64Bit ? '64-bit' : '32-bit')),
      },
      {
        label: 'CPU',
        value: facts(
          system && (system.cpuModel.trim() === '' ? system.cpuVendor : system.cpuModel),
          system &&
            positive(system.cpuPhysicalCores) &&
            positive(system.cpuCores) &&
            `${system.cpuPhysicalCores} cores / ${system.cpuCores} threads`,
          system && positive(system.cpuSpeedMhz) && `${system.cpuSpeedMhz} MHz`,
        ),
      },
      {
        label: 'RAM',
        value:
          positive(status.processRamMb) || positive(ramTotalMb)
            ? `${formatRamMb(status.processRamMb)} of ${formatRamMb(ramTotalMb)}`
            : DASH,
      },
      {
        label: 'Display',
        value: facts(
          system &&
            positive(system.displayWidth) &&
            positive(system.displayHeight) &&
            `${system.displayWidth} × ${system.displayHeight}`,
          system &&
            positive(system.displayScale) &&
            `${Math.round(system.displayScale * 100)}% scale`,
          system && system.displayCount > 1 && count(system.displayCount, 'display'),
        ),
      },
      {
        label: 'Window',
        value: facts(
          positive(browser.viewportWidth) &&
            positive(browser.viewportHeight) &&
            `${browser.viewportWidth} × ${browser.viewportHeight} CSS px`,
          positive(browser.devicePixelRatio) && `DPR ${browser.devicePixelRatio}`,
        ),
      },
      {
        label: 'Locale',
        value: facts(
          dash(browser.language) === DASH
            ? facts(system?.language, system?.region)
            : browser.language,
          browser.timeZone,
        ),
      },
    ],
  };
}

function audioSection(input: DiagnosticsInput): DiagSection {
  const { info, status } = input;
  const audio = info.audio;
  // The engine's defaults would report 44100/512 before the first status push,
  // which is a guess — say so rather than making one up.
  const rate = positive(status.sampleRate) ? `${Math.round(status.sampleRate)} Hz` : undefined;
  const buffer = positive(status.bufferSize) ? `${status.bufferSize} samples` : undefined;

  const deviceLatency = audio
    ? Math.max(0, audio.inputLatencySamples) + Math.max(0, audio.outputLatencySamples)
    : 0;

  return {
    title: 'Audio',
    rows: [
      { label: 'Driver', value: facts(audio?.driverType, audio?.deviceName) },
      {
        label: 'Format',
        value: facts(rate, buffer, audio && positive(audio.bitDepth) && `${audio.bitDepth}-bit`),
      },
      {
        label: 'Channels',
        value: audio ? `${audio.inputChannels} in / ${audio.outputChannels} out` : DASH,
      },
      {
        label: 'Latency',
        value: facts(
          audio &&
            `device ${deviceLatency} samples${
              millis(deviceLatency, status.sampleRate)
                ? ` (${millis(deviceLatency, status.sampleRate)})`
                : ''
            }`,
          `chain ${status.chainLatencySamples} samples${
            millis(status.chainLatencySamples, status.sampleRate)
              ? ` (${millis(status.chainLatencySamples, status.sampleRate)})`
              : ''
          }`,
        ),
      },
      {
        label: 'Dropouts',
        // -1 is JUCE's "this driver cannot count them"; reporting 0 there would
        // claim a clean session the driver never vouched for.
        value:
          status.audioXRuns < 0
            ? `${DASH} (driver does not report)`
            : count(status.audioXRuns, 'XRun'),
      },
      {
        label: 'Load',
        value: `${Math.round(Math.max(0, status.cpuLoad) * 100)}% of the audio budget`,
      },
    ],
  };
}

/** The installed plugins, grouped under the vendor each one reports:
    `Neural DSP: Archetype, Gateway · Waves: SSL Comp`.

    Grouped rather than listed flat because a library is mostly a handful of
    vendors, and the vendor is half of what identifies a plugin in a bug report.
    Plugins that report no manufacturer keep their names and sort last, so an
    empty prefix never reads as a vendor called "". */
function formatPluginLibrary(plugins: PluginInfo[]): string {
  if (plugins.length === 0) return 'none';

  const byVendor = new Map<string, string[]>();
  for (const plugin of plugins) {
    const vendor = (plugin.manufacturer ?? '').trim();
    const names = byVendor.get(vendor) ?? [];
    names.push(dash(plugin.name));
    byVendor.set(vendor, names);
  }

  return [...byVendor]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([vendor, names]) => {
      const list = names.sort((a, b) => a.localeCompare(b)).join(', ');
      return vendor === '' ? list : `${vendor}: ${list}`;
    })
    .join(' · ');
}

/** What the host knows about, and what it will not load. Its own section
    because the list is long enough to bury the rig rows it used to sit among —
    and because "which plugins are installed" is the first question a crash
    report raises. */
function pluginsSection(input: DiagnosticsInput): DiagSection {
  const { info, scan, plugins, blacklisted } = input;
  // The list the section prints wins over the engine's count when it has
  // entries, so the number can never contradict the names right below it.
  const skipped = blacklisted.length > 0 ? blacklisted.length : (info.plugins?.blacklisted ?? 0);

  return {
    title: 'Plugins',
    rows: [
      {
        label: 'Library',
        value: facts(
          `${info.plugins?.known ?? scan.pluginCount} known`,
          // Only worth a mention when a plugin actually crashed a scan.
          positive(skipped) && `${skipped} skipped`,
          `scan ${scan.status}`,
        ),
      },
      { label: 'Installed', value: formatPluginLibrary(plugins) },
      {
        label: 'Skipped',
        // File names, not the paths they came from: the path is under the
        // user's account and this report is written for a public issue.
        value:
          blacklisted.length === 0
            ? 'none'
            : blacklisted
                .map((entry) => dash(entry.name))
                .sort((a, b) => a.localeCompare(b))
                .join(' · '),
      },
    ],
  };
}

function rigSection(input: DiagnosticsInput): DiagSection {
  const { status, rack, routing, settings, library } = input;
  const lanes = routing.groups.reduce((total, group) => total + group.lanes.length, 0);
  const knobs = rack.reduce((total, module) => total + module.params.length, 0);
  const bypassed = rack.filter((module) => module.bypassed).length;

  // Disabled is the whole story — the stage is then always 'active' and the
  // thresholds describe a countdown that never runs.
  const standby = settings.standbyEnabled
    ? facts(
        status.standbyStage,
        `light after ${settings.standbyLightAfterMinutes} min`,
        settings.standbyDeepAfterMinutes > 0
          ? `deep after ${settings.standbyDeepAfterMinutes} min`
          : 'deep off',
        `wake above ${settings.standbyWakeThresholdDb} dBFS`,
        status.standbyBlocked && 'held off',
      )
    : 'off';

  return {
    title: 'Rig',
    rows: [
      {
        label: 'Rack',
        value: facts(
          count(rack.length, 'module'),
          `${count(routing.groups.length, 'split')}${lanes > 0 ? ` (${count(lanes, 'lane')})` : ''}`,
          `${bypassed} bypassed`,
          `${count(knobs, 'knob')} mapped`,
        ),
      },
      { label: 'Chain', value: formatChain(rack, routing) },
      {
        label: 'Storage',
        value: facts(
          `${count(library.rigs, 'rig')} saved`,
          `${count(library.scenes, 'scene')} in the current rig`,
        ),
      },
      { label: 'Standby', value: standby },
    ],
  };
}

function issuesSection(input: DiagnosticsInput): DiagSection {
  const { status, busy } = input;
  const failures = status.standbyWakeFailures;

  const rows: DiagRow[] = [
    {
      label: 'Wake failures',
      // Plugin names, which are in scope; the error text comes from the plugin
      // or the host, not from the user.
      value:
        failures.length === 0
          ? 'none'
          : failures.map((failure) => `${failure.name} (${failure.error})`).join(' · '),
    },
    {
      label: 'Engine',
      value: busy.isBusy
        ? facts('busy', busy.loading && `loading ${busy.loading.current}/${busy.loading.total}`)
        : 'idle',
    },
  ];

  return { title: 'Issues', rows };
}

/** Builds the whole report. Section order is the order someone triaging reads
    them: what it is, what it ran on, how audio was configured, how big the rig
    was, which plugins were around, and what is currently wrong. */
export function buildDiagnostics(input: DiagnosticsInput): DiagReport {
  return {
    sections: [
      appSection(input),
      systemSection(input),
      audioSection(input),
      rigSection(input),
      pluginsSection(input),
      issuesSection(input),
    ],
  };
}

/** The clipboard form: the same rows, aligned into one plain-text block. Labels
    are padded to a single width across all sections so the values line up when
    pasted into a monospaced issue body. */
export function formatDiagnostics(report: DiagReport): string {
  const width = Math.max(
    0,
    ...report.sections.flatMap((section) => section.rows.map((row) => row.label.length)),
  );

  return report.sections
    .map((section) =>
      [
        section.title,
        ...section.rows.map((row) => `  ${row.label.padEnd(width)}  ${row.value}`),
      ].join('\n'),
    )
    .join('\n\n');
}
