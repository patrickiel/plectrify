import { afterEach, describe, expect, it } from 'vitest';
import { JuceEngine } from './JuceEngine';

/** What one crossing of the unpatched Linux pipe did to a string. */
function damage(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join('');
}

/** Enough of the native bridge for a page to boot against: the data root as a
    map of path to text, and the three file events answered from it. */
function fakeBridge(platform: string, files: Record<string, string>) {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const emit = (id: string, data: unknown) =>
    queueMicrotask(() => listeners.get(id)?.forEach((listener) => listener(data)));
  const reads: string[] = [];
  const writes: string[] = [];

  const backend = {
    addEventListener(id: string, fn: (data: unknown) => void) {
      listeners.set(id, [...(listeners.get(id) ?? []), fn]);
      return 0;
    },
    removeEventListener() {},
    emitEvent(id: string, payload: unknown) {
      const { requestId, path, dir, text } = payload as Record<string, string>;
      if (id === 'readFile') {
        reads.push(path!);
        const found = path! in files;
        emit('fileRead', { requestId, ok: found, text: found ? files[path!] : '' });
      } else if (id === 'writeFile') {
        writes.push(path!);
        files[path!] = text!;
        emit('fileWritten', { requestId, ok: true });
      } else if (id === 'listFiles') {
        const prefix = dir ? `${dir}/` : '';
        const below = Object.keys(files)
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length));
        emit('filesListed', {
          requestId,
          names: below.filter((name) => !name.includes('/')),
          dirs: [...new Set(below.filter((n) => n.includes('/')).map((n) => n.split('/')[0]))],
        });
      }
    },
  };
  (globalThis as { window?: unknown }).window = {
    __JUCE__: { backend, initialisationData: { platform: [platform], host: ['standalone'] } },
  };
  return { files, reads, writes };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const patch = (name: string) =>
  JSON.stringify({ name, pluginName: 'Neural Amp Modeler', knobs: [], state: 'QUJD' }, null, 2);

function damagedRoot(): Record<string, string> {
  return {
    'settings.json': JSON.stringify({
      rackZoom: 1.25,
      drawerPatchOrder: { [`patches:${damage(damage('Verstärker'))}`]: ['a', 'b'] },
    }),
    'patches/a.patch': patch(damage(damage(damage('EVH 5150III® 100S')))),
    'patches/b.patch': patch('Plain'),
    'rigs/index.json': JSON.stringify([{ id: 'r', name: damage('Città'), file: 'rigs/r.rig' }]),
    'looper-sessions/index.json': '[]',
    'looper-sessions/take.wav': 'RIFFÃ©',
  };
}

describe('the one-time repair of text the Linux bridge garbled', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('rewrites the damaged documents on Linux and records that it has', async () => {
    const { files, reads, writes } = fakeBridge('linux', damagedRoot());
    const engine = new JuceEngine();
    await engine.settingsReady();
    await settle();

    expect(JSON.parse(files['patches/a.patch']!).name).toBe('EVH 5150III® 100S');
    expect(JSON.parse(files['rigs/index.json']!)[0].name).toBe('Città');
    const settings = JSON.parse(files['settings.json']!);
    expect(settings.drawerPatchOrder).toEqual({ 'patches:Verstärker': ['a', 'b'] });
    expect(settings.rackZoom).toBe(1.25);
    expect(settings.storedTextRepaired).toBe(true);
    // Untouched: a document with nothing to repair, and a recording.
    expect(writes).not.toContain('patches/b.patch');
    expect(reads).not.toContain('looper-sessions/take.wav');
  });

  it('does not run again once the flag is stored', async () => {
    const root = damagedRoot();
    root['settings.json'] = JSON.stringify({ storedTextRepaired: true });
    const { files, writes } = fakeBridge('linux', root);
    const engine = new JuceEngine();
    await engine.settingsReady();
    await settle();

    expect(JSON.parse(files['patches/a.patch']!).name).not.toBe('EVH 5150III® 100S');
    expect(writes).not.toContain('patches/a.patch');
  });

  it('never runs on a platform whose bridge was intact', async () => {
    for (const platform of ['windows', 'macos']) {
      const { files, writes } = fakeBridge(platform, damagedRoot());
      const engine = new JuceEngine();
      await engine.settingsReady();
      await settle();

      expect(writes).not.toContain('patches/a.patch');
      expect(JSON.parse(files['settings.json']!).storedTextRepaired).toBeUndefined();
    }
  });

  it('writes no settings file on a machine that has none', async () => {
    const { files } = fakeBridge('linux', { 'patches/a.patch': patch(damage('Señor')) });
    const engine = new JuceEngine();
    await engine.settingsReady();
    await settle();

    expect(JSON.parse(files['patches/a.patch']!).name).toBe('Señor');
    expect('settings.json' in files).toBe(false);
  });
});
