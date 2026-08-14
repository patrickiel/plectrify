<script lang="ts">
  import type { Scene } from '../../lib/engine/types';
  import SwitcherGroup from '../../lib/components/SwitcherGroup.svelte';
  import ItemMenuPanel from '../../lib/components/ItemMenuPanel.svelte';
  import { SCENE_SHORTCUT_KEYS } from './shortcutKeys';

  interface Props {
    scenes: Scene[];
    activeSceneId: string | null;
    /** Edit mode keeps the caret and puts the management menu behind it. */
    editMode: boolean;
    /** Scene mid-apply — its segment shows a spinner until it converges. */
    pendingSceneId?: string | null;
    /** Whether there's anything worth capturing (empty rack → no scenes). */
    canSave: boolean;
    onSave: (name: string) => void;
    onApply: (sceneId: string) => void;
    onRename: (sceneId: string, name: string) => void;
    onDelete: (sceneId: string) => void;
    /** Reorder the scene list — drives the segments and the menu. */
    onMove: (sceneId: string, toIndex: number) => void;
    /** The active scene has unsaved changes — shows a dot on its segment. */
    dirty?: boolean;
    /** Width budget from the toolbar half hosting this group (see TopToolbar). */
    maxWidth?: number;
    /** False while a rack-level state must block performance navigation. */
    shortcutsEnabled: boolean;
  }

  let {
    scenes,
    activeSceneId,
    editMode,
    pendingSceneId = null,
    canSave,
    onSave,
    onApply,
    onRename,
    onDelete,
    onMove,
    dirty = false,
    maxWidth = 0,
    shortcutsEnabled,
  }: Props = $props();
</script>

<SwitcherGroup
  items={scenes}
  activeId={activeSceneId}
  pendingId={pendingSceneId}
  {editMode}
  {maxWidth}
  tag="Scene"
  groupLabel="Scenes"
  noneLabel="No scene"
  menuLabel="Manage scenes"
  moreLabel="More scenes"
  {dirty}
  shortcutKeys={SCENE_SHORTCUT_KEYS}
  {shortcutsEnabled}
  onSelect={onApply}
>
  {#snippet menu(close)}
    <ItemMenuPanel
      items={scenes}
      activeId={activeSceneId}
      listLabel="Scenes"
      emptyLabel="No scenes yet"
      savePlaceholder="Scene {scenes.length + 1}"
      saveInputLabel="Scene name"
      {canSave}
      shortcutKeys={SCENE_SHORTCUT_KEYS}
      onSelect={onApply}
      {onSave}
      {onRename}
      {onDelete}
      {onMove}
      {close}
    />
  {/snippet}
</SwitcherGroup>
