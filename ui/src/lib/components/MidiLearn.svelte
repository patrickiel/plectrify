<script lang="ts" module>
  import type { MidiActionId } from '../engine/types';

  /** What the wrapped card gets to drive its own controls in learn mode. */
  export interface MidiLearnApi<A extends MidiActionId = MidiActionId> {
    /** True while the card is in learn mode — the controls become targets. */
    readonly on: boolean;
    /** The control waiting for a press, if any. */
    readonly armed: A | null;
    /** Whether this action already has a trigger. */
    bound(action: A): boolean;
    /** A learn-mode click on a control: armed → cancel, bound → clear,
        otherwise arm. The MIDI settings dialog's cycle. */
    click(action: A): void;
    /** What a learnable control's tooltip says while learn mode is on. */
    tip(action: A, label: string): string;
  }
</script>

<script lang="ts" generics="A extends MidiActionId">
  import { onMount, type Snippet } from 'svelte';
  import { PianoKeysIcon } from 'phosphor-svelte';
  import type { EngineBridge } from '../engine/EngineBridge';
  import type { AppSettings } from '../engine/types';
  import { slide } from 'svelte/transition';
  import { assignBinding, clearBinding, describeTrigger, isPress, triggerOf } from '../engine/midi';
  import Button from './Button.svelte';
  import { createReveal } from './reveal.svelte';

  /**
   * The in-panel MIDI learn mode shared by the looper, metronome and song
   * transport: the switch that flips the card into learn mode, and the state
   * machine behind it.
   *
   * One switch flips the whole card: its real controls become the learn
   * targets, so "map the stop switch" is literally "click Stop, press the
   * switch" — no shadow list of rows to cross-reference. The card wraps its
   * content in this component and gets a `MidiLearnApi` to drive those
   * controls; the switch renders after that content, at the foot of the card.
   *
   * Visibility belongs to the host. Expert tool views keep this available
   * independently of rack Edit mode; hosts that do tie it to Edit mode pass
   * that condition through `showControl`.
   *
   * No counter next to the switch, and no help line under it: the controls
   * themselves show what is mapped, and the switch's own label carries the one
   * instruction that applies right now.
   */
  interface Props {
    engine: EngineBridge;
    /** Every action this card can learn. */
    actions: readonly A[];
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Whether the card is in learn mode. Bindable: App owns the flag so it
        can pause the rack's live MIDI dispatch while a learn is armed, and
        disarm from outside when the MIDI settings dialog opens. */
    active?: boolean;
    /** A learn armed elsewhere (another tool, the rack) — this switch then
        refuses to arm a second one. */
    otherLearnActive?: boolean;
    /** Tooltip while the mode is off: what mapping this card involves. */
    startTip: string;
    /** Stage view: the card scales up to be readable from standing distance. */
    large?: boolean;
    /** Rule the switch off from the content above it. A panel built from
        {@link Card}s sets this false: the gap between its cards already does
        that work. */
    divider?: boolean;
    /** Progressive-disclosure hook for hosts with a simplified view. Hiding
        the switch also ends an active learn so real controls stay live. */
    showControl?: boolean;
    /** Hands the same learn API to a control that lives *outside* this
        component's content — the tool panel's Maximize button, which belongs to
        the panel header (ToolSidebar) rather than to the tool. Called once, on
        init: the API object is stable and reads live state through getters. */
    onApi?: (api: MidiLearnApi<A>) => void;
    /** The card's own content, handed the learn API. */
    children: Snippet<[MidiLearnApi<A>]>;
  }

  let {
    engine,
    actions,
    appSettings,
    onSetAppSettings,
    active = $bindable(false),
    otherLearnActive = false,
    startTip,
    large = false,
    divider = true,
    showControl = true,
    onApi,
    children,
  }: Props = $props();

  // The switch is a Simple/Expert reveal like the rows above it: hosts that
  // hide it in Simple get the same motion the tool's own blocks have.
  const reveal = createReveal();

  let armed = $state<A | null>(null);
  // A plain function, not a $derived, so the MIDI callback below can read it
  // from outside any reactive context.
  const learning = (): boolean => active && showControl;
  const currentArmed = (): A | null => (learning() ? armed : null);

  function toggle() {
    if (!active && otherLearnActive) return; // one armed learn app-wide
    active = !active;
  }

  // A hidden learner must hand the active flag back: App uses it to pause live
  // MIDI dispatch while a press is being captured.
  $effect(() => {
    if (!showControl && active) active = false;
  });

  const api: MidiLearnApi<A> = {
    get on() {
      return learning();
    },
    get armed() {
      return currentArmed();
    },
    bound(action) {
      return !!appSettings.midiBindings[action];
    },
    click(action) {
      if (currentArmed() === action) {
        armed = null;
        return;
      }
      if (appSettings.midiBindings[action]) {
        onSetAppSettings({ midiBindings: clearBinding(appSettings.midiBindings, action) });
        return;
      }
      armed = action;
    },
    tip(action, label) {
      if (currentArmed() === action) return 'Listening — press a switch';
      const trigger = appSettings.midiBindings[action];
      if (trigger) return `${label}: ${describeTrigger(trigger)} — click to clear`;
      return `Click, then press the switch for ${label}`;
    },
  };

  // After mount, not during init: the receiver stores it in its own state, and
  // that store would otherwise land in the middle of the parent's render.
  onMount(() => {
    onApi?.(api);
  });

  const anyBound = $derived(actions.some((action) => appSettings.midiBindings[action]));

  // The switch says what to do next rather than what it is — there is no room
  // for a line of help under it, and a card in learn mode has exactly one
  // instruction at a time. Clicking it still leaves the mode (the tooltip says
  // so), which is the only thing the label drops.
  const label = $derived(
    !active ? 'MIDI learn' : armed !== null ? 'Press a switch' : 'Click a button to map',
  );

  // Learn capture: the first press while a control is armed becomes its
  // binding (releases ignored, last-learn-wins — the MIDI dialog's semantics).
  // The mode stays on afterwards so the next control can be learned in the
  // same visit. onMount rather than $effect: the engine is created once.
  onMount(() =>
    engine.subscribeMidiEvents((events) => {
      const target = currentArmed();
      if (target === null) return;
      const press = events.find(isPress);
      if (!press) return;
      onSetAppSettings({
        midiBindings: assignBinding(appSettings.midiBindings, target, triggerOf(press)),
      });
      armed = null;
    }),
  );
</script>

{@render children(api)}

{#if showControl}
  <div
    class={[
      'flex shrink-0 flex-col gap-[.35rem]',
      divider && 'mt-[.2rem] border-t border-control-edge-hair pt-[.45rem]',
    ]}
    transition:slide={reveal.slide()}
  >
    <!-- `md`, not `lg`, at stage size: the switch is chrome at the foot of the
         card, so it steps up a notch rather than to the full stage scale the
         card's own controls take. -->
    <Button
      block
      size={large ? 'md' : 'sm'}
      tone={active ? 'accent' : 'neutral'}
      aria-pressed={active}
      onclick={toggle}
      tip={active ? 'Leave MIDI learn mode' : startTip}
    >
      <PianoKeysIcon size={14} weight={anyBound ? 'fill' : 'regular'} aria-hidden="true" />
      <span role="status">{label}</span>
    </Button>
  </div>
{/if}
