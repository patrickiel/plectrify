import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../lib/engine/appSettings';
import { DEFAULT_APP_INFO, DEFAULT_STATUS_STATE } from '../../lib/engine/types';
import type { AppInfo, RackModule, RoutingState, StatusState } from '../../lib/engine/types';
import type { BrowserFacts } from './browserFacts';
import { buildDiagnostics, formatDiagnostics, type DiagnosticsInput } from './diagnostics';

const info: AppInfo = {
  version: '0.1.0',
  build: 'Release',
  os: 'Windows 11',
  juceVersion: 'JUCE v8.0.14',
  buildInfo: {
    commit: 'abc1234',
    dirty: false,
    builtAt: '2026-07-30 12:00 UTC',
    compiler: 'MSVC 19.44',
    asio: true,
    vst3: true,
  },
  system: {
    os64Bit: true,
    cpuModel: 'Ryzen 9 5900X',
    cpuVendor: 'AuthenticAMD',
    cpuSpeedMhz: 3700,
    cpuCores: 24,
    cpuPhysicalCores: 12,
    ramTotalMb: 32768,
    language: 'de',
    region: 'CH',
    displayWidth: 3840,
    displayHeight: 2160,
    displayScale: 1.5,
    displayCount: 2,
  },
  audio: {
    driverType: 'ASIO',
    deviceName: 'Focusrite USB ASIO',
    bitDepth: 24,
    inputChannels: 1,
    outputChannels: 2,
    inputLatencySamples: 128,
    outputLatencySamples: 192,
  },
  plugins: { known: 38, blacklisted: 1 },
};

const status: StatusState = {
  ...DEFAULT_STATUS_STATE,
  sampleRate: 48000,
  bufferSize: 128,
  audioXRuns: 0,
  uptimeSeconds: 4320,
  chainLatencySamples: 64,
  totalLatencySamples: 384,
  cpuLoad: 0.18,
  processRamMb: 512,
};

const browser: BrowserFacts = {
  webViewVersion: '141.0.3485.44',
  rendererFamily: 'chromium',
  viewportWidth: 1440,
  viewportHeight: 860,
  devicePixelRatio: 1.5,
  language: 'de-CH',
  timeZone: 'Europe/Zurich',
};

const mod = (over: Partial<RackModule> = {}): RackModule => ({
  id: 'm1',
  name: 'Mock Amp',
  pluginVersion: '2.1.0',
  bypassed: false,
  params: [],
  availableParams: [],
  ...over,
});

const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  info,
  status,
  rack: [mod()],
  routing: { groups: [] },
  scan: { status: 'idle', pluginCount: 38 },
  plugins: [
    { id: 'p1', name: 'Mock Amp', manufacturer: 'Mock Audio' },
    { id: 'p2', name: 'Mock Drive', manufacturer: 'Mock Audio' },
    { id: 'p3', name: 'Nameless Verb' },
    { id: 'p4', name: 'Acme Comp', manufacturer: 'Acme' },
  ],
  blacklisted: [{ path: 'C:\\Program Files\\Common Files\\VST3\\Crasher.vst3', name: 'Crasher' }],
  busy: { isBusy: false },
  settings: DEFAULT_APP_SETTINGS,
  browser,
  ui: { buildStamp: '2026-07-30 12:01', commit: 'abc1234' },
  library: { rigs: 3, scenes: 4 },
  ...over,
});

/** The value of one row, by section and label — the report's own addressing,
    so a test says what it means instead of matching substrings of a blob. */
const row = (report: ReturnType<typeof buildDiagnostics>, section: string, label: string) => {
  const found = report.sections.find((candidate) => candidate.title === section);
  expect(found, `section ${section}`).toBeDefined();
  const match = found!.rows.find((candidate) => candidate.label === label);
  expect(match, `${section} / ${label}`).toBeDefined();
  return match!.value;
};

describe('buildDiagnostics', () => {
  it('reports the app, the machine, the audio setup, the rig and what is wrong', () => {
    const report = buildDiagnostics(input());

    expect(report.sections.map((section) => section.title)).toEqual([
      'App',
      'System',
      'Audio',
      'Rig',
      'Plugins',
      'Issues',
    ]);

    expect(row(report, 'App', 'Version')).toBe('0.1.0 (Release)');
    expect(row(report, 'App', 'Commit')).toBe('abc1234');
    expect(row(report, 'App', 'Engine')).toBe('JUCE v8.0.14');
    expect(row(report, 'App', 'Renderer')).toBe('WebView2 141.0.3485.44');
    expect(row(report, 'App', 'Formats')).toBe('VST3 · ASIO built in');
    expect(row(report, 'App', 'Uptime')).toBe('1 h 12 min');

    expect(row(report, 'System', 'OS')).toBe('Windows 11 · 64-bit');
    expect(row(report, 'System', 'CPU')).toBe('Ryzen 9 5900X · 12 cores / 24 threads · 3700 MHz');
    expect(row(report, 'System', 'RAM')).toBe('512 MB of 32.0 GB');
    expect(row(report, 'System', 'Display')).toBe('3840 × 2160 · 150% scale · 2 displays');
    expect(row(report, 'System', 'Locale')).toBe('de-CH · Europe/Zurich');

    expect(row(report, 'Audio', 'Driver')).toBe('ASIO · Focusrite USB ASIO');
    expect(row(report, 'Audio', 'Format')).toBe('48000 Hz · 128 samples · 24-bit');
    expect(row(report, 'Audio', 'Channels')).toBe('1 in / 2 out');
    expect(row(report, 'Audio', 'Latency')).toBe(
      'device 320 samples (6.7 ms) · chain 64 samples (1.3 ms)',
    );
    expect(row(report, 'Audio', 'Dropouts')).toBe('0 XRuns');
    expect(row(report, 'Audio', 'Load')).toBe('18% of the audio budget');

    expect(row(report, 'Rig', 'Storage')).toBe('3 rigs saved · 4 scenes in the current rig');
    // Off is the whole story: the thresholds describe a countdown that never runs.
    expect(row(report, 'Rig', 'Standby')).toBe('off');

    expect(row(report, 'Plugins', 'Library')).toBe('38 known · 1 skipped · scan idle');
    // Grouped by vendor, vendors and names each alphabetical, and the plugin
    // that reports no manufacturer sorts last without an empty prefix.
    expect(row(report, 'Plugins', 'Installed')).toBe(
      'Acme: Acme Comp · Mock Audio: Mock Amp, Mock Drive · Nameless Verb',
    );
    expect(row(report, 'Plugins', 'Skipped')).toBe('Crasher');

    expect(row(report, 'Issues', 'Wake failures')).toBe('none');
    expect(row(report, 'Issues', 'Engine')).toBe('idle');
  });

  it('says so plainly when nothing is installed and nothing is skipped', () => {
    const report = buildDiagnostics(input({ plugins: [], blacklisted: [] }));
    expect(row(report, 'Plugins', 'Installed')).toBe('none');
    expect(row(report, 'Plugins', 'Skipped')).toBe('none');
  });

  it('reports the macOS renderer as WebKit and drops the ASIO fact there', () => {
    // ASIO does not exist on macOS, so "no ASIO" would be noise in every mac
    // report; and the version number WKWebView carries is WebKit's own.
    const report = buildDiagnostics(
      input({
        info: {
          ...info,
          os: 'macOS 14.5',
          platform: 'macos',
          buildInfo: { ...info.buildInfo!, compiler: 'Clang 16.0', asio: false },
        },
        browser: { ...browser, webViewVersion: '605.1.15', rendererFamily: 'webkit' },
      }),
    );

    expect(row(report, 'App', 'Renderer')).toBe('WebKit 605.1.15');
    expect(row(report, 'App', 'Formats')).toBe('VST3');
  });

  it('still states the ASIO fact on Windows, where its absence explains a missing device type', () => {
    const report = buildDiagnostics(
      input({ info: { ...info, buildInfo: { ...info.buildInfo!, asio: false } } }),
    );
    expect(row(report, 'App', 'Formats')).toBe('VST3 · no ASIO');
  });

  it('dashes every field the engine has not reported yet', () => {
    const report = buildDiagnostics(
      input({
        info: DEFAULT_APP_INFO,
        status: { ...DEFAULT_STATUS_STATE, sampleRate: 0, bufferSize: 0 },
        browser: { ...browser, webViewVersion: '', language: '', timeZone: '' },
        ui: { buildStamp: '', commit: '' },
        rack: [],
        library: { rigs: 0, scenes: 0 },
      }),
    );

    // No invented version, commit, device or sample rate — and no empty "()".
    expect(row(report, 'App', 'Version')).toBe('—');
    expect(row(report, 'App', 'Commit')).toBe('—');
    expect(row(report, 'App', 'Built')).toBe('—');
    expect(row(report, 'App', 'Formats')).toBe('—');
    expect(row(report, 'App', 'Renderer')).toBe('—');
    expect(row(report, 'System', 'CPU')).toBe('—');
    expect(row(report, 'Audio', 'Driver')).toBe('—');
    expect(row(report, 'Audio', 'Format')).toBe('—');
    expect(row(report, 'Audio', 'Channels')).toBe('—');

    const text = formatDiagnostics(report);
    expect(text).not.toMatch(/NaN|undefined|null/);
    // A zero rate must not reach the report as a real one.
    expect(text).not.toContain('0 Hz');
  });

  it('says a dropout count the driver cannot provide is unknown, not zero', () => {
    const unknown = buildDiagnostics(input({ status: { ...status, audioXRuns: -1 } }));
    expect(row(unknown, 'Audio', 'Dropouts')).toBe('— (driver does not report)');

    const counted = buildDiagnostics(input({ status: { ...status, audioXRuns: 1 } }));
    expect(row(counted, 'Audio', 'Dropouts')).toBe('1 XRun');
  });

  it('singularises the rack counts', () => {
    const report = buildDiagnostics(input({ rack: [mod()], library: { rigs: 1, scenes: 1 } }));
    expect(row(report, 'Rig', 'Rack')).toBe('1 module · 0 splits · 0 bypassed · 0 knobs mapped');
    expect(row(report, 'Rig', 'Storage')).toBe('1 rig saved · 1 scene in the current rig');
  });

  it('lists the chain in signal order, with parallel lanes bracketed', () => {
    const routing: RoutingState = {
      groups: [
        {
          id: 'g1',
          position: 1,
          lanes: [
            { id: 'l1', name: 'Crunch', gain: 1, pan: 0, muted: false, soloed: false },
            { id: 'l2', name: 'Clean', gain: 1, pan: 0, muted: false, soloed: false },
          ],
        },
      ],
    };
    const rack = [
      mod({ id: 'a', name: 'Mock Drive', pluginVersion: '1.0.4' }),
      mod({ id: 'b', name: 'Mock Amp', laneId: 'l1' }),
      mod({ id: 'c', name: 'Mock Reverb', pluginVersion: '3.2' }),
    ];

    const report = buildDiagnostics(input({ rack, routing }));
    // Lanes are labelled by position, never by their (user-renameable) names.
    expect(row(report, 'Rig', 'Chain')).toBe(
      'Mock Drive 1.0.4 → [A: Mock Amp 2.1.0 | B: (empty)] → Mock Reverb 3.2',
    );
    expect(row(report, 'Rig', 'Rack')).toBe(
      '3 modules · 1 split (2 lanes) · 0 bypassed · 0 knobs mapped',
    );
  });

  it('reports a split that sits after the last serial module', () => {
    const routing: RoutingState = {
      groups: [
        {
          id: 'g1',
          position: 1,
          lanes: [{ id: 'l1', name: 'A', gain: 1, pan: 0, muted: false, soloed: false }],
        },
      ],
    };
    const rack = [
      mod({ id: 'a', name: 'Mock Drive', pluginVersion: '1.0.4' }),
      mod({ id: 'b', laneId: 'l1' }),
    ];
    const report = buildDiagnostics(input({ rack, routing }));
    expect(row(report, 'Rig', 'Chain')).toBe('Mock Drive 1.0.4 → [A: Mock Amp 2.1.0]');
  });

  it('names the plugins that failed to wake, and the engine progress', () => {
    const report = buildDiagnostics(
      input({
        status: {
          ...status,
          standbyWakeFailures: [{ name: 'Mock Amp', error: 'plugin not found' }],
        },
        busy: { isBusy: true, loading: { current: 3, total: 7 } },
      }),
    );
    expect(row(report, 'Issues', 'Wake failures')).toBe('Mock Amp (plugin not found)');
    expect(row(report, 'Issues', 'Engine')).toBe('busy · loading 3/7');
  });

  it('spells out the standby policy once it is armed', () => {
    const report = buildDiagnostics(
      input({
        settings: { ...DEFAULT_APP_SETTINGS, standbyEnabled: true, standbyDeepAfterMinutes: 30 },
        status: { ...status, standbyStage: 'light', standbyBlocked: true },
      }),
    );
    expect(row(report, 'Rig', 'Standby')).toBe(
      'light · light after 10 min · deep after 30 min · wake above -50 dBFS · held off',
    );
  });

  it('flags a UI bundle built from a different commit than the app', () => {
    const matching = buildDiagnostics(input());
    expect(row(matching, 'App', 'UI bundle')).toBe('2026-07-30 12:01 · abc1234');

    const stale = buildDiagnostics(
      input({ ui: { buildStamp: '2026-07-01 09:00', commit: 'old9999' } }),
    );
    expect(row(stale, 'App', 'UI bundle')).toBe(
      "2026-07-01 09:00 · old9999 · doesn't match the app",
    );
  });

  it('never carries a name the user typed, or a path', () => {
    const report = buildDiagnostics(
      input({
        rack: [
          mod({ id: 'a', name: 'Mock Amp', displayName: 'My Secret Tone' }),
          mod({ id: 'b', name: 'Mock Drive', laneId: 'l1' }),
        ],
        routing: {
          groups: [
            {
              id: 'g1',
              position: 1,
              lanes: [
                { id: 'l1', name: 'Gigi lane', gain: 1, pan: 0, muted: false, soloed: false },
              ],
            },
          ],
        },
      }),
    );

    const text = formatDiagnostics(report);
    expect(text).not.toContain('My Secret Tone');
    expect(text).not.toContain('Gigi lane');
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\//);
    // The plugin identities it *should* carry are still there.
    expect(text).toContain('Mock Amp 2.1.0');
  });
});

describe('formatDiagnostics', () => {
  it('serialises every rendered row, aligned under its section', () => {
    const report = buildDiagnostics(input());
    const text = formatDiagnostics(report);

    for (const section of report.sections) {
      expect(text).toContain(`${section.title}\n`);
      for (const { label, value } of section.rows) expect(text).toContain(`${label}`);
      for (const { value } of section.rows) expect(text).toContain(value);
    }
    // Sections are separated by a blank line, rows are indented under them.
    expect(text).toContain('\n\nSystem\n');
    expect(text.split('\n').filter((line) => line.startsWith('  ')).length).toBe(
      report.sections.reduce((total, section) => total + section.rows.length, 0),
    );
  });
});
