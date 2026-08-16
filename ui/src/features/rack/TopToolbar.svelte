<script lang="ts">
  import { DownloadSimpleIcon, FloppyDiskIcon, XIcon } from 'phosphor-svelte';
  import type { Rig, Scene } from '../../lib/engine/types';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import ToolbarButton from '../../lib/components/ToolbarButton.svelte';
  import RigBar from './RigBar.svelte';
  import SceneBar from './SceneBar.svelte';

  interface Props {
    rigs: Rig[];
    activeRig: Rig | undefined;
    dirty: boolean;
    canSave: boolean;
    scenes: Scene[];
    activeSceneId: string | null;
    sceneDirty: boolean;
    editMode?: boolean;
    /** False while busy, parked or covered by a rack-level dialog. */
    shortcutsEnabled: boolean;
    onSaveRig: (name: string) => void;
    /** Persist every open change at once (scene drift + the active rig). */
    onSaveAll: () => void;
    /** Throw every open change away, back to what is on disk. */
    onDiscardAll: () => void;
    onLoadRig: (rigId: string) => void;
    onRenameRig: (rigId: string, name: string) => void;
    onDeleteRig: (rigId: string) => void;
    onMoveRig: (rigId: string, toIndex: number) => void;
    onNewRig: () => void;
    onSaveScene: (name: string) => void;
    onApplyScene: (sceneId: string) => void;
    onRenameScene: (sceneId: string, name: string) => void;
    onDeleteScene: (sceneId: string) => void;
    onMoveScene: (sceneId: string, toIndex: number) => void;
    /** Scene mid-apply — its switcher segment spins until it converges. */
    pendingSceneId?: string | null;
    /** Development-only export of the currently rendered view. */
    onExportView?: () => void | Promise<void>;
  }

  let {
    rigs,
    activeRig,
    dirty,
    canSave,
    scenes,
    activeSceneId,
    sceneDirty,
    editMode = $bindable(false),
    shortcutsEnabled,
    onSaveRig,
    onSaveAll,
    onDiscardAll,
    onLoadRig,
    onRenameRig,
    onDeleteRig,
    onMoveRig,
    onNewRig,
    onSaveScene,
    onApplyScene,
    onRenameScene,
    onDeleteScene,
    onMoveScene,
    pendingSceneId = null,
    onExportView,
  }: Props = $props();

  // The rig and scene groups meet at the exact centre of the bar: two equal
  // grid halves, the rig group docked at the end of the left half and the
  // scene group at the start of the right. Each grows away from the seam, so
  // neither ever pushes the other (or the controls beside it) around. The
  // groups cannot measure their own available space without feeding back
  // into that measurement, so each half hands its group the width left after
  // the half's fixed neighbours.
  let leftHalfWidth = $state(0);
  let rightHalfWidth = $state(0);
  let modeToggleWidth = $state(0);
  // One flex gap beside the mode toggle plus the half-gap at the seam.
  const LEFT_FIXED_EXTRA = 12; // px
  // Save + discard buttons (2.25rem each) plus the gaps around them.
  const RIGHT_FIXED_WIDTH = 2 * 36 + 3 * 8; // px
  const rigMaxWidth = $derived(
    leftHalfWidth === 0 ? 0 : Math.max(0, leftHalfWidth - modeToggleWidth - LEFT_FIXED_EXTRA),
  );
  const sceneMaxWidth = $derived(
    rightHalfWidth === 0 ? 0 : Math.max(0, rightHalfWidth - RIGHT_FIXED_WIDTH),
  );

  // The single Save button covers both kinds of open change, and Discard is its
  // mirror image; the tooltips spell out exactly what one click will act on.
  const activeScene = $derived(scenes.find((s) => s.id === activeSceneId));
  const sceneSaveable = $derived(sceneDirty && !!activeScene);
  const rigSaveable = $derived(dirty && !!activeRig);
  const hasOpenChanges = $derived(sceneSaveable || rigSaveable);
  const changedParts = $derived.by(() => {
    const parts: string[] = [];
    if (sceneSaveable && activeScene) parts.push(`scene “${activeScene.name}”`);
    if (rigSaveable && activeRig) parts.push(`rig “${activeRig.name}”`);
    return parts.join(' and ');
  });
  const saveTitle = $derived(changedParts ? `Save changes to ${changedParts}` : 'Save changes');
  const discardTitle = $derived(
    changedParts ? `Discard changes to ${changedParts}` : 'Discard changes',
  );
</script>

<!-- The toolbar stays outside the rack scroller so its controls remain fixed
     while the signal chain moves below it. -->
<header
  class="relative z-40 flex-none [zoom:var(--ui-scale,1)] bg-chrome backdrop-blur-[18px] after:absolute after:right-(--tool-rail-w) after:bottom-0 after:left-0 after:h-px after:bg-[var(--toolbar-divider)] after:shadow-[0_10px_28px_color-mix(in_srgb,var(--color-void)_34%,transparent)] after:content-['']"
>
  <div class="[scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden">
    <nav
      class="grid h-[3.9rem] min-w-[40rem] grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center px-4 [--tb-gap:.5rem] lg:px-8"
      aria-label="Rack controls"
    >
      <div
        class="flex min-w-0 items-center justify-between gap-(--tb-gap) pr-[calc(var(--tb-gap)/2)]"
        bind:clientWidth={leftHalfWidth}
      >
        <SegmentedControl
          label="Rack mode"
          value={editMode}
          compact={false}
          bind:width={modeToggleWidth}
          options={[
            {
              value: false,
              label: 'Perform',
              tip: 'Play the rack without editing controls',
            },
            {
              value: true,
              label: 'Edit',
              tip: 'Edit the rack: add, remove, and configure modules',
              tone: 'accent',
            },
          ]}
          onSelect={(nextEditMode) => (editMode = nextEditMode)}
        />
        <RigBar
          {rigs}
          {activeRig}
          {editMode}
          {shortcutsEnabled}
          maxWidth={rigMaxWidth}
          {canSave}
          dirty={rigSaveable}
          onSave={onSaveRig}
          onLoad={onLoadRig}
          onRename={onRenameRig}
          onDelete={onDeleteRig}
          onMove={onMoveRig}
          onNew={onNewRig}
        />
      </div>

      <div
        class="flex min-w-0 items-center gap-(--tb-gap) pl-[calc(var(--tb-gap)/2)]"
        bind:clientWidth={rightHalfWidth}
      >
        <SceneBar
          {scenes}
          {activeSceneId}
          {editMode}
          {shortcutsEnabled}
          {pendingSceneId}
          maxWidth={sceneMaxWidth}
          {canSave}
          dirty={sceneSaveable}
          onSave={onSaveScene}
          onApply={onApplyScene}
          onRename={onRenameScene}
          onDelete={onDeleteScene}
          onMove={onMoveScene}
        />
        <ToolbarButton
          iconOnly
          label={saveTitle}
          tip={saveTitle}
          tone={hasOpenChanges ? 'accent' : 'neutral'}
          disabled={!hasOpenChanges}
          onclick={onSaveAll}
        >
          <FloppyDiskIcon size={17} />
        </ToolbarButton>
        <ToolbarButton
          iconOnly
          label={discardTitle}
          tip={discardTitle}
          tone="warn"
          disabled={!hasOpenChanges}
          onclick={onDiscardAll}
        >
          <XIcon size={17} weight="bold" />
        </ToolbarButton>
        {#if onExportView}
          <ToolbarButton
            iconOnly
            class="ml-auto"
            label="Export current view"
            tip="Export current view as HTML"
            onclick={() => void onExportView?.()}
            data-export-view
          >
            <DownloadSimpleIcon size={17} />
          </ToolbarButton>
        {/if}
      </div>
    </nav>
  </div>
</header>

<style>
  /* The bar's own hairline. Everything the bar *hosts* — the mode toggle, the
     rig/scene SwitcherGroups, the save/discard buttons — wears the shared
     chrome skin (`--chrome-control-*` in app.css) instead, which the tool
     sidebar's panels wear too, so the whole frame reads as one family. */
  header {
    --toolbar-divider: color-mix(in srgb, var(--color-ink) calc(8% * var(--ink-k)), transparent);
  }
</style>
