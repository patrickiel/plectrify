import { EMPTY_AUDIO_DEVICES, type AudioDevicesState, type AudioDriverInfo } from './types';

/** Validate an `audioDevicesChanged` payload field by field.

    The same reasoning as every other normalizer here: the engine and the page
    ship independently (a Debug build serves whatever `ui/dist` happens to
    hold), so a field that is missing or the wrong shape has to degrade into
    "nothing offered" rather than into a wizard that renders undefined. The one
    field with a semantic guard is `inputChannel`, which is an index into
    `inputChannels` and is clamped to it — a saved choice can outlive the
    interface it named. */
export function normalizeAudioDevices(value: unknown): AudioDevicesState {
  const source = (value ?? {}) as Partial<Record<keyof AudioDevicesState, unknown>>;
  const inputChannels = stringList(source.inputChannels);

  return {
    drivers: drivers(source.drivers),
    driver: text(source.driver),
    outputDevice: text(source.outputDevice),
    inputDevice: text(source.inputDevice),
    open: source.open === true,
    sampleRate: positive(source.sampleRate),
    sampleRates: numberList(source.sampleRates),
    bufferSize: positive(source.bufferSize),
    bufferSizes: numberList(source.bufferSizes),
    recommendedBufferSize: positive(source.recommendedBufferSize),
    inputChannels,
    // A device with no channels leaves this at 0, which names nothing and is
    // exactly what the wizard's input step is there to fix.
    inputChannel: clampIndex(source.inputChannel, inputChannels.length),
    deviceLatencySamples:
      typeof source.deviceLatencySamples === 'number' && source.deviceLatencySamples >= 0
        ? Math.round(source.deviceLatencySamples)
        : -1,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : [];
}

function clampIndex(value: unknown, length: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  return length > 0 ? Math.min(value, length - 1) : 0;
}

function drivers(value: unknown): AudioDriverInfo[] {
  if (!Array.isArray(value)) return EMPTY_AUDIO_DEVICES.drivers;
  return value
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      name: text(entry.name),
      separateInputsAndOutputs: entry.separateInputsAndOutputs === true,
      outputDevices: stringList(entry.outputDevices),
      inputDevices: stringList(entry.inputDevices),
    }))
    .filter((driver) => driver.name !== '');
}

/** How long one block of `size` samples lasts, in milliseconds. Zero for a
    device that has not reported a rate — a block of unknown duration is not a
    block of zero duration, but there is nothing truer to show. */
export function bufferMilliseconds(size: number, sampleRate: number): number {
  return sampleRate > 0 ? (1000 * size) / sampleRate : 0;
}

/** The driver family a rig should be on, or '' when the one it is on is
    already the best available.

    Only ever ASIO, and only on Windows: it is the one family that talks to the
    interface directly, where the others are a shared system mixer with a buffer
    of their own on top of ours. Returns nothing on macOS, where CoreAudio is
    both the only family and the low-latency one, so the wizard has no advice to
    give and says nothing rather than filling the space. */
export function betterDriverAvailable(state: AudioDevicesState): string {
  const asio = state.drivers.find((driver) => driver.name.toUpperCase() === 'ASIO');
  if (asio === undefined || asio.outputDevices.length === 0) return '';
  return state.driver.toUpperCase() === 'ASIO' ? '' : asio.name;
}

/** The devices a driver family offers for one end of the signal path. A family
    that does not separate the two names one device for both, so the same list
    answers either question. */
export function devicesOf(driver: AudioDriverInfo | undefined, end: 'input' | 'output'): string[] {
  if (driver === undefined) return [];
  if (!driver.separateInputsAndOutputs) return driver.outputDevices;
  return end === 'input' ? driver.inputDevices : driver.outputDevices;
}
