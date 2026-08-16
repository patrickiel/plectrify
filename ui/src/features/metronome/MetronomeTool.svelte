<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { PauseIcon, PlayIcon } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppSettings, StatusState } from '../../lib/engine/types';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import MidiLearn, { type MidiLearnApi } from '../../lib/components/MidiLearn.svelte';
  import { learnStateOf } from '../../lib/components/learnSkin';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import Select from '../../lib/components/Select.svelte';
  import { cycleLevel, resizePattern, sanitizePattern, stepLevel } from './beatPattern';
  import { extrapolateBeat, MAX_BPM, MIN_BPM, type MetronomeSnapshot } from './metronomeBeat';
  import { wheelDelta } from './tempoWheel';

  interface Props {
    engine: EngineBridge;
    status: StatusState;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Tap history is App-owned so a MIDI tap still works while this panel is closed. */
    onTap: () => void;
    midiLearning?: boolean;
    otherLearnActive?: boolean;
    large?: boolean;
    /** Hands this card's learn API to the panel header, whose Maximize button
        is one of the actions mapped here. */
    onLearnApi?: (api: MidiLearnApi<MetronomeMidiAction>) => void;
  }

  type MetronomeMidiAction =
    | 'metronomeToggle'
    | 'metronomeTapTempo'
    | 'metronomeTempoDown'
    | 'metronomeTempoUp'
    | 'metronomeMaximize';

  let {
    engine,
    status,
    appSettings,
    onSetAppSettings,
    onTap,
    midiLearning = $bindable(false),
    otherLearnActive = false,
    large = false,
    onLearnApi,
  }: Props = $props();

  // Maximized is the stage view: the dial and the transport, nothing else. The
  // setup rows and MIDI learn are bench work, so full screen is always Simple
  // whatever the sidebar was left on — the header drops the switch to match.
  const expert = $derived(!large && appSettings.metronomeViewMode === 'expert');
  // Motion for what Expert reveals — see reveal.svelte.ts.
  const reveal = createReveal();
  const controlRowHeight = $derived(large ? 'h-14' : 'h-12');

  // Bare numbers — the trigger's SUB/BEATS caption already says what they mean.
  // 1 is the exception: "no subdivision" reads clearer than a lone "1".
  const subdivisionOptions = Array.from({ length: 4 }, (_, index) => ({
    value: String(index + 1),
    label: index === 0 ? 'No subdivision' : String(index + 1),
  }));
  const beatOptions = Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  }));
  const accents = $derived(sanitizePattern(status.metronomeAccents, status.metronomeBeatsPerBar));

  function setBpm(value: number) {
    const bpm = Math.round(Math.max(MIN_BPM, Math.min(MAX_BPM, value)) * 4) / 4;
    engine.setStatus({ metronomeBpm: bpm });
  }

  function setBeats(value: string) {
    const beats = Number(value);
    engine.setStatus({
      metronomeBeatsPerBar: beats,
      metronomeAccents: resizePattern(accents, beats),
    });
  }

  function setBeatLevel(
    index: number,
    level: (current: (typeof accents)[number]) => (typeof accents)[number],
  ) {
    const next = [...accents];
    next[index] = level(next[index]);
    engine.setStatus({ metronomeAccents: next });
  }

  // The engine sends beat/phase at 15 Hz. Advance the latest snapshot on an
  // animation frame so the pad highlight moves smoothly through every beat.
  const snapshot = $derived<MetronomeSnapshot>({
    running: status.metronomeEnabled,
    bpm: status.metronomeBpm,
    beatsPerBar: status.metronomeBeatsPerBar,
    beat: status.metronomeBeat,
    beatPhase: status.metronomeBeatPhase,
    receivedAtMs: performance.now(),
  });
  let frameNow = $state(0);
  onMount(() => {
    let raf = requestAnimationFrame(function tick() {
      frameNow = performance.now();
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });
  const display = $derived(
    status.metronomeEnabled
      ? extrapolateBeat(snapshot, frameNow)
      : { beat: snapshot.beat, phase: snapshot.beatPhase },
  );

  // Wheel drag uses per-move deltas, matching Knob.svelte: long drags do not
  // depend on the press point and Shift can enter/leave fine mode live.
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;
  let dragBpm = 120;
  // A press that never moves far enough to change the tempo is a click on the
  // dial, which toggles play — the dial is the biggest target in the panel.
  let dragMoved = false;
  const CLICK_SLOP_PX = 4;
  let downX = 0;
  let downY = 0;
  function wheelDown(event: PointerEvent) {
    if (event.button !== 0) return;
    dragging = true;
    dragMoved = false;
    lastX = downX = event.clientX;
    lastY = downY = event.clientY;
    dragBpm = status.metronomeBpm;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function wheelMove(event: PointerEvent) {
    if (!dragging) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) dragMoved = true;
    dragBpm += wheelDelta(event.clientX - lastX, event.clientY - lastY, event.shiftKey);
    lastX = event.clientX;
    lastY = event.clientY;
    setBpm(dragBpm);
  }
  function wheelUp(learning = false) {
    if (dragging && !dragMoved && !learning) engine.metronomeCommand('toggle');
    dragging = false;
  }
  function wheelCancel() {
    dragging = false;
  }
  function wheelKey(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1;
    setBpm(status.metronomeBpm + direction * (event.shiftKey ? 0.25 : 1));
  }

  // Wheel-to-adjust. Attached by hand rather than with `onwheel` so the
  // listener is non-passive and can swallow the panel's scroll.
  function wheelAdjust(step: (direction: number, fine: boolean) => void) {
    return (node: HTMLElement) => {
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        step(event.deltaY < 0 ? 1 : -1, event.shiftKey);
      };
      node.addEventListener('wheel', onWheel, { passive: false });
      return () => node.removeEventListener('wheel', onWheel);
    };
  }

  function setLevelDb(value: number) {
    engine.setStatus({ metronomeLevelDb: Math.max(-40, Math.min(0, value)) });
  }

  // The meter tiles and the accent pads are Buttons in everything but markup —
  // a Select trigger, a drag label, a pad — so they restate Button's pill skin
  // rather than inventing one: same chrome well, same edge, same hover as the
  // Tap and Play buttons above them.
  const tileClass =
    'rounded-control-lg border border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] shadow-[var(--chrome-control-shadow)] [transition:var(--ctl-transition)] hover:border-[color:var(--chrome-control-active-border)] hover:bg-[var(--chrome-control-hover-bg)] hover:text-ink';

  // Learn mode — the switch, the hint and the state machine all live in
  // MidiLearn, which wraps the card's controls below.
  // metronomeMaximize's button lives in the panel header; the header borrows
  // this card's learn API (onLearnApi) so it maps like any control here.
  const METRONOME_ACTIONS: MetronomeMidiAction[] = [
    'metronomeToggle',
    'metronomeTapTempo',
    'metronomeTempoDown',
    'metronomeTempoUp',
    'metronomeMaximize',
  ];
</script>

<section
  class={[
    'flex flex-col items-stretch gap-[.55rem] px-[.6rem] pt-2 pb-[.6rem] text-ink select-none [--metronome-color:color-mix(in_srgb,var(--color-ink)_45%,transparent)]',
    status.metronomeEnabled && '[--metronome-color:var(--color-accent)]',
    !large && 'min-h-full',
    // Maximized: fill the stage top to bottom — the dial takes whatever height
    // the fixed-height control rows leave, so there is no dead band around it.
    large && 'mx-auto h-full w-full max-w-176 gap-[.9rem] px-[1.4rem] pt-[1.2rem] pb-[1.6rem]',
  ]}
  aria-label="Metronome"
>
  <!-- Simple/Expert lives in the panel header (ToolSidebar) — see LooperTool. -->
  <!-- MidiLearn wraps the controls and renders the learn switch after them. -->
  <MidiLearn
    {engine}
    {appSettings}
    {onSetAppSettings}
    {otherLearnActive}
    {large}
    showControl={expert}
    actions={METRONOME_ACTIONS}
    onApi={onLearnApi}
    bind:active={midiLearning}
    startTip="Map play, tap tempo and the tempo nudges to MIDI switches"
  >
    {#snippet children(learn)}
      <!-- The tempo dial gets the panel card the looper's pedal has: same
           border, same fill, so the two tools read as one family. Stage view
           holds nothing but this group, so there is nothing to tell it apart
           from — the chrome drops and the dial sits on the panel itself. -->
      <Card
        class={[
          'flex flex-col gap-[.55rem] p-2',
          large ? 'min-h-0 flex-1 border-0 bg-transparent' : 'flex-none',
        ]}
      >
        <div
          class={[
            'relative mx-auto w-full cursor-grab touch-none bg-transparent px-[.7rem] pt-2 pb-[.35rem] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--metronome-color)',
            dragging && 'cursor-grabbing',
            // A size container so the dial below can read the height it has
            // left (`cqh`) and pick the larger of the two fits.
            large && '@container-size flex min-h-0 flex-1 items-center justify-center',
          ]}
          role="slider"
          tabindex="0"
          aria-label="Tempo"
          aria-valuemin={MIN_BPM}
          aria-valuemax={MAX_BPM}
          aria-valuenow={status.metronomeBpm}
          onpointerdown={wheelDown}
          onpointermove={wheelMove}
          onpointerup={() => wheelUp(learn.on)}
          onpointercancel={wheelCancel}
          onlostpointercapture={wheelCancel}
          onkeydown={wheelKey}
          {@attach wheelAdjust((direction, fine) =>
            setBpm(status.metronomeBpm + direction * (fine ? 0.25 : 1)),
          )}
        >
          <!-- The arc's open bottom ends near y=96, so the viewBox trims some
             of the dead band under the wheel rather than running to 120. -->
          <!-- A container so the readout can size in `cqw` — the number then
               keeps its proportion to the dial at any zoom or window size. -->
          <!-- Maximized: as wide as the card allows, or as wide as the leftover
               height can carry (the viewBox is 120×108, so 111% of it) —
               whichever is smaller. Width still drives the layout, so the
               readout keeps its place on the arc. -->
          <div class={['@container relative', large && 'w-[min(100%,111cqh)]']}>
            <svg class="block w-full" viewBox="0 0 120 108" aria-hidden="true">
              <circle
                class="fill-none stroke-control-edge [stroke-width:7] [stroke-linecap:round]"
                cx="60"
                cy="60"
                r="45"
                pathLength="100"
                stroke-dasharray="75 25"
                transform="rotate(135 60 60)"
              />
              <circle
                class="fill-(--metronome-color) [filter:drop-shadow(0_0_3px_color-mix(in_srgb,var(--metronome-color)_70%,transparent))]"
                cx="60"
                cy="15"
                r="2.7"
                transform={`rotate(${((status.metronomeBpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 270 - 135} 60 60)`}
              />
            </svg>
            <!-- Readout only: tapping and nudging moved to the row below, so
               the dial's centre is free to stay a plain number. Centred on the
               dial (y=60 of 108), not on the cropped box. -->
            <div
              class="pointer-events-none absolute top-[55.6%] left-1/2 grid -translate-1/2 place-items-center font-mono text-[color-mix(in_srgb,var(--color-ink)_85%,transparent)]"
            >
              <span
                class="col-start-1 row-start-1 text-[14cqw] leading-normal font-bold tracking-[-.06em] tabular-nums"
                >{Math.round(status.metronomeBpm)}</span
              >
              <span
                class="col-start-1 row-start-1 mt-(--bpm-unit-offset) font-mono text-[4.2cqw] leading-normal font-medium tracking-[.16em] text-muted [--bpm-unit-offset:18cqw]"
                >BPM</span
              >
            </div>
          </div>
        </div>

        <!-- Nudge / tap / nudge — one row, all three the play bar's height. -->
        <div class="flex items-stretch gap-[.35rem]">
          <Button
            size={large ? 'lg' : 'md'}
            class={['w-12 shrink-0 text-xl leading-none', controlRowHeight]}
            learn={learnStateOf(learn, 'metronomeTempoDown')}
            aria-label="Decrease tempo"
            tip={learn.on
              ? learn.tip('metronomeTempoDown', 'Decrease tempo')
              : 'Decrease tempo — hold Shift for 5'}
            onclick={(e) =>
              learn.on
                ? learn.click('metronomeTempoDown')
                : setBpm(status.metronomeBpm - (e.shiftKey ? 5 : 1))}>−</Button
          >
          <Button
            block
            size={large ? 'lg' : 'md'}
            class={['min-w-0 flex-1 rounded-control-lg', controlRowHeight]}
            learn={learnStateOf(learn, 'metronomeTapTempo')}
            onclick={() => (learn.on ? learn.click('metronomeTapTempo') : onTap())}
            aria-label={learn.on ? learn.tip('metronomeTapTempo', 'Tap tempo') : 'Tap tempo'}
          >
            Tap
          </Button>
          <Button
            size={large ? 'lg' : 'md'}
            class={['w-12 shrink-0 text-xl leading-none', controlRowHeight]}
            learn={learnStateOf(learn, 'metronomeTempoUp')}
            aria-label="Increase tempo"
            tip={learn.on
              ? learn.tip('metronomeTempoUp', 'Increase tempo')
              : 'Increase tempo — hold Shift for 5'}
            onclick={(e) =>
              learn.on
                ? learn.click('metronomeTempoUp')
                : setBpm(status.metronomeBpm + (e.shiftKey ? 5 : 1))}>+</Button
          >
        </div>

        <!-- Running takes the accent tone, which reads --ctl-accent — re-pointed
             at --metronome-color on this button only, so the bar carries the
             tool's state colour without dyeing the rest of the card's controls
             (the MIDI learn switch keeps the app accent). -->
        <Button
          block
          size={large ? 'lg' : 'md'}
          tone={status.metronomeEnabled ? 'accent' : 'neutral'}
          class={['rounded-control-lg [--ctl-accent:var(--metronome-color)]', controlRowHeight]}
          learn={learnStateOf(learn, 'metronomeToggle')}
          onclick={() =>
            learn.on ? learn.click('metronomeToggle') : engine.metronomeCommand('toggle')}
          aria-label={learn.on
            ? learn.tip('metronomeToggle', 'Play or pause')
            : status.metronomeEnabled
              ? 'Pause metronome'
              : 'Start metronome'}
        >
          {#if status.metronomeEnabled}<PauseIcon size={17} weight="fill" />{:else}<PlayIcon
              size={17}
              weight="fill"
            />{/if}
          {status.metronomeEnabled ? 'Pause' : 'Play'}
        </Button>
      </Card>

      {#if expert}
        <!-- The wrapper carries the reveal: Expert opens this whole block, and a
             component cannot take a transition directly. -->
        <div class="flex-none" transition:slide={reveal.slide()}>
          <!-- Meter, level and the accent pads share the dial's card treatment,
             so the panel reads as two blocks rather than loose rows. -->
          <Card class="flex flex-col gap-[.55rem] p-2">
            <div class="flex items-center justify-between gap-[.35rem]">
              <!-- The wheel listener lives on a wrapper because attachments go on
             elements, not components; `display: contents` keeps the row layout. -->
              <div
                class="contents"
                {@attach wheelAdjust((direction) =>
                  engine.setStatus({
                    metronomeSubdivision: Math.max(
                      1,
                      Math.min(subdivisionOptions.length, status.metronomeSubdivision + direction),
                    ),
                  }),
                )}
              >
                <Select
                  options={subdivisionOptions}
                  value={String(status.metronomeSubdivision)}
                  onSelect={(value) => engine.setStatus({ metronomeSubdivision: Number(value) })}
                  filterable={false}
                  class={[
                    'flex shrink-0 grow-0 basis-[3.4rem] flex-col items-center justify-center gap-[.1rem] text-[.62rem] text-muted focus-visible:border-[color:var(--chrome-control-active-border)] focus-visible:text-ink focus-visible:outline-none',
                    tileClass,
                    controlRowHeight,
                  ]}
                  aria-label="Beat subdivision"
                >
                  {#snippet trigger()}
                    <span class="text-[1.05rem] leading-none font-bold text-ink tabular-nums"
                      >{status.metronomeSubdivision}</span
                    >
                    <span class="font-mono text-[.55rem] leading-normal font-medium tracking-[.1em]"
                      >SUB</span
                    >
                  {/snippet}
                </Select>
              </div>

              <div
                class="contents"
                {@attach wheelAdjust((direction) =>
                  setBeats(
                    String(
                      Math.max(
                        1,
                        Math.min(beatOptions.length, status.metronomeBeatsPerBar + direction),
                      ),
                    ),
                  ),
                )}
              >
                <Select
                  options={beatOptions}
                  value={String(status.metronomeBeatsPerBar)}
                  onSelect={setBeats}
                  filterable={false}
                  class={[
                    'flex shrink-0 grow-0 basis-[3.4rem] flex-col items-center justify-center gap-[.1rem] text-[.62rem] text-muted focus-visible:border-[color:var(--chrome-control-active-border)] focus-visible:text-ink focus-visible:outline-none',
                    tileClass,
                    controlRowHeight,
                  ]}
                  aria-label="Beats per bar"
                >
                  {#snippet trigger()}
                    <span class="text-[1.05rem] leading-none font-bold text-ink tabular-nums"
                      >{status.metronomeBeatsPerBar}</span
                    >
                    <span class="font-mono text-[.55rem] leading-normal font-medium tracking-[.1em]"
                      >BEATS</span
                    >
                  {/snippet}
                </Select>
              </div>

              <label
                class={[
                  'relative flex min-w-0 flex-1 cursor-ew-resize flex-col items-center justify-center gap-[.1rem] overflow-hidden text-[.62rem] text-muted focus-within:border-[color:var(--chrome-control-active-border)] focus-within:text-ink',
                  tileClass,
                  controlRowHeight,
                ]}
                {@attach wheelAdjust((direction) =>
                  setLevelDb(status.metronomeLevelDb + direction),
                )}
              >
                <!-- The same fill strength the accent pads below use: on the
                   chrome well a lighter tint disappears, and level and accents
                   are the same kind of readout. -->
                <span
                  class="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--metronome-color)_58%,transparent)] transition-[width] duration-80"
                  style:width={`${((status.metronomeLevelDb + 40) / 40) * 100}%`}
                ></span>
                <span
                  class="pointer-events-none relative text-[1.05rem] leading-none font-bold text-ink tabular-nums"
                  >{#if status.metronomeLevelDb < 0}<span class="absolute right-full">−</span
                    >{/if}{Math.abs(status.metronomeLevelDb)}</span
                >
                <span
                  class="pointer-events-none relative font-mono text-[.55rem] leading-normal font-medium tracking-[.1em]"
                  >VOL</span
                >
                <input
                  class="absolute inset-0 m-0 h-full w-full cursor-ew-resize opacity-0"
                  type="range"
                  min="-40"
                  max="0"
                  step="1"
                  aria-label="Click level"
                  value={status.metronomeLevelDb}
                  oninput={(e) =>
                    engine.setStatus({ metronomeLevelDb: Number(e.currentTarget.value) })}
                />
              </label>
            </div>

            <div
              class={['grid gap-[.18rem]', controlRowHeight]}
              style:grid-template-columns={`repeat(${status.metronomeBeatsPerBar}, minmax(0, 1fr))`}
              aria-label="Beat accents"
            >
              {#each accents as level, index (index)}
                {@const lit = status.metronomeEnabled && display.beat === index}
                <!-- The lit pad is styled inline, not by a conditional utility:
                   this button restates tileClass by hand, so a `border-`/`bg-`
                   variant would collide with it and lose on CSS source order
                   (raw elements get no cn() merge). Inline always wins, and
                   re-pointing the well's own variables keeps the chrome intact. -->
                <button
                  type="button"
                  class={[
                    'relative min-w-0 cursor-pointer overflow-hidden p-0 [--pad-fill:color-mix(in_srgb,var(--metronome-color)_58%,transparent)]',
                    tileClass,
                  ]}
                  style:--pad-fill={lit ? 'var(--metronome-color)' : null}
                  style:border-color={lit ? 'var(--metronome-color)' : null}
                  style:box-shadow={lit
                    ? '0 0 0 1px var(--metronome-color), 0 0 12px color-mix(in srgb, var(--metronome-color) 55%, transparent)'
                    : null}
                  onclick={() => setBeatLevel(index, cycleLevel)}
                  {@attach wheelAdjust((direction) =>
                    setBeatLevel(index, (level) => stepLevel(level, direction)),
                  )}
                  aria-label={`Beat ${index + 1}: ${['off', 'normal', 'normal', 'accent'][level]}`}
                >
                  <!-- A muted beat has no fill to brighten, so the pad's edge and
                     halo above are what carry the position on those. -->
                  <span
                    class="absolute inset-x-0 bottom-0 bg-(--pad-fill) transition-[height] duration-100"
                    style:height={level === 3 ? '100%' : level > 0 ? '50%' : '0%'}
                  ></span>
                </button>
              {/each}
            </div>
          </Card>
        </div>
      {/if}

      <!-- In the sidebar, keep MIDI learn at the panel foot. This collapses
           naturally when the controls need the full height. -->
      {#if expert && !large}<div class="min-h-0 flex-1"></div>{/if}
    {/snippet}
  </MidiLearn>
</section>
