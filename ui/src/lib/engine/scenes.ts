import type {
  RackModule,
  RoutingState,
  Scene,
  SceneLaneState,
  SceneModuleState,
  SceneSwitchState,
} from './types';
import { uid } from './ids';

/** Normalised parameter values that differ by less than this are considered
    equal, absorbing float round-trips through the engine's 15 Hz value echo. */
export const SCENE_VALUE_EPSILON = 1e-4;

/** Capture the rack's current abstracted surface as a named scene: mapped
    (non-meter) parameter values, bypass states, and lane state. De-dupes by
    paramIndex — two knobs on the same parameter contribute one entry. */
export function captureScene(name: string, rack: RackModule[], routing: RoutingState): Scene {
  return {
    id: uid('scene'),
    name: name.trim() || 'Scene',
    modules: rack.map((module) => ({
      moduleId: module.id,
      bypassed: module.bypassed,
      params: sceneParamsForModule(module),
    })),
    lanes: routing.groups.flatMap((group) =>
      group.lanes.map(({ id, gain, pan, muted, soloed }) => ({
        laneId: id,
        gain,
        pan,
        muted,
        soloed,
      })),
    ),
    switches: routing.groups.map(({ id, activeLaneId }) => ({ groupId: id, activeLaneId })),
  };
}

/** The parameter values a scene tracks for one module: mapped non-meter knobs,
    de-duped by paramIndex. Shared by capture and reconcile so the two can never
    disagree about which params belong to a scene. */
export function sceneParamsForModule(
  module: RackModule,
): Array<{ paramIndex: number; value: number }> {
  return dedupeByParamIndex(module.params.filter((p) => !p.isMeter));
}

function dedupeByParamIndex(params: Array<{ paramIndex: number; value: number }>) {
  const seen = new Map<number, number>();
  for (const p of params) if (!seen.has(p.paramIndex)) seen.set(p.paramIndex, p.value);
  return [...seen.entries()].map(([paramIndex, value]) => ({ paramIndex, value }));
}

/** Whether the live rack still matches what the scene stores — the scene
    "dirty" check. Only scene-relevant fields are compared; modules or lanes the
    scene doesn't know about are ignored (they had no state to drift from).
    The reverse is a mismatch: entries whose module is gone, or a scene with no
    module entries against a non-empty rack, report dirty. With the engines
    keeping scenes structurally reconciled (`reconcileScenes`), those branches
    only fire in transient windows — mid rig apply, before the post-apply
    reconcile — where the dirty flag is suppressed anyway. */
export function sceneMatchesLive(scene: Scene, rack: RackModule[], routing: RoutingState): boolean {
  if (rack.length > 0 && scene.modules.length === 0) return false;
  const modules = new Map(rack.map((m) => [m.id, m]));
  for (const entry of scene.modules) {
    const module = modules.get(entry.moduleId);
    if (!module) return false;
    if (module.bypassed !== entry.bypassed) return false;
    const live = new Map(module.params.map((p) => [p.paramIndex, p.value]));
    for (const p of entry.params) {
      const value = live.get(p.paramIndex);
      if (value !== undefined && Math.abs(value - p.value) > SCENE_VALUE_EPSILON) return false;
    }
  }

  const lanes = new Map(
    routing.groups.flatMap((g) => g.lanes.map((lane) => [lane.id, lane] as const)),
  );
  for (const entry of scene.lanes) {
    const lane = lanes.get(entry.laneId);
    if (!lane) continue;
    if (
      Math.abs(lane.gain - entry.gain) > SCENE_VALUE_EPSILON ||
      Math.abs(lane.pan - entry.pan) > SCENE_VALUE_EPSILON ||
      lane.muted !== entry.muted ||
      lane.soloed !== entry.soloed
    )
      return false;
  }

  const groups = new Map(routing.groups.map((g) => [g.id, g]));
  for (const entry of scene.switches) {
    const group = groups.get(entry.groupId);
    if (!group) continue;
    if ((group.activeLaneId ?? undefined) !== (entry.activeLaneId ?? undefined)) return false;
  }

  return true;
}

/** Re-key scenes after a stored rack was applied and module clientIds were
    re-minted. Entries whose module no longer exists are dropped; lane/switch
    ids are stable across applies and pass through untouched. Dropping is
    data loss (the scene forgets that module's state), so it is logged —
    a scene that loses every entry becomes an inert husk until re-saved. */
export function remapSceneIds(scenes: Scene[], idMap: Map<string, string>): Scene[] {
  return scenes.map((scene) => {
    const modules = scene.modules.flatMap((entry) => {
      const moduleId = idMap.get(entry.moduleId);
      return moduleId ? [{ ...entry, moduleId }] : [];
    });
    const dropped = scene.modules.length - modules.length;
    if (dropped > 0)
      console.warn(
        `Scene "${scene.name}" lost ${dropped} of ${scene.modules.length} module entries: ` +
          'their modules are not part of the applied rack.',
      );
    return { ...scene, modules };
  });
}

export interface ReconcileOptions {
  /** JuceEngine: a knob's live value is a placeholder until the engine has
      streamed it once. When provided, a missing param entry is only backfilled
      once its value is known — a later reconcile (on the next paramValues
      echo) picks it up. Pruning is never gated. */
  hasKnownValue?: (moduleId: string, paramIndex: number) => boolean;
}

/** Make every scene mirror the live rack STRUCTURE: prune entries whose
    module / mapped param / lane / group no longer exists, and backfill missing
    entries from current live state. Values already stored in a scene are never
    overwritten — reconciliation adds and removes entries, nothing else — so a
    structural edit can't silently rewrite what a scene will recall. Unchanged
    scenes keep their object identity and an unchanged list returns the input
    array with `changed: false`, letting callers skip notifications. */
export function reconcileScenes(
  scenes: Scene[],
  rack: RackModule[],
  routing: RoutingState,
  options?: ReconcileOptions,
): { scenes: Scene[]; changed: boolean } {
  const known = options?.hasKnownValue ?? (() => true);
  const liveModules = new Map(rack.map((m) => [m.id, m]));
  const liveLanes = new Map(
    routing.groups.flatMap((g) => g.lanes.map((lane) => [lane.id, lane] as const)),
  );

  let changed = false;
  const next = scenes.map((scene) => {
    let sceneChanged = false;

    // Modules: drop entries whose module left the rack, sync each survivor's
    // param set to the currently mapped (non-meter) knobs, then append entries
    // for modules the scene has never seen, seeded from their live state.
    const modules: SceneModuleState[] = [];
    for (const entry of scene.modules) {
      const module = liveModules.get(entry.moduleId);
      if (!module) {
        sceneChanged = true;
        continue;
      }
      const mapped = sceneParamsForModule(module);
      const mappedIndexes = new Set(mapped.map((p) => p.paramIndex));
      const stored = new Set(entry.params.map((p) => p.paramIndex));
      const kept = entry.params.filter((p) => mappedIndexes.has(p.paramIndex));
      const added = mapped.filter(
        (p) => !stored.has(p.paramIndex) && known(module.id, p.paramIndex),
      );
      if (kept.length === entry.params.length && added.length === 0) {
        modules.push(entry);
      } else {
        sceneChanged = true;
        modules.push({ ...entry, params: [...kept, ...added] });
      }
    }
    const present = new Set(modules.map((entry) => entry.moduleId));
    for (const module of rack) {
      if (present.has(module.id)) continue;
      sceneChanged = true;
      modules.push({
        moduleId: module.id,
        bypassed: module.bypassed,
        params: sceneParamsForModule(module).filter((p) => known(module.id, p.paramIndex)),
      });
    }

    // Lanes: prune the removed, backfill the new from the live mix.
    const lanes: SceneLaneState[] = [];
    for (const entry of scene.lanes) {
      if (!liveLanes.has(entry.laneId)) {
        sceneChanged = true;
        continue;
      }
      lanes.push(entry);
    }
    const laneIds = new Set(lanes.map((entry) => entry.laneId));
    for (const [laneId, lane] of liveLanes) {
      if (laneIds.has(laneId)) continue;
      sceneChanged = true;
      lanes.push({
        laneId,
        gain: lane.gain,
        pan: lane.pan,
        muted: lane.muted,
        soloed: lane.soloed,
      });
    }

    // Switches: prune removed groups, backfill new ones from the live
    // selection. A kept entry whose activeLaneId points at a removed lane is
    // re-seeded from live too — the stored selection no longer exists, and
    // keeping it would leave the scene permanently dirty.
    const switches: SceneSwitchState[] = [];
    const liveGroups = new Map(routing.groups.map((g) => [g.id, g]));
    for (const entry of scene.switches) {
      const group = liveGroups.get(entry.groupId);
      if (!group) {
        sceneChanged = true;
        continue;
      }
      if (entry.activeLaneId && !group.lanes.some((lane) => lane.id === entry.activeLaneId)) {
        sceneChanged = true;
        switches.push({ groupId: entry.groupId, activeLaneId: group.activeLaneId });
      } else {
        switches.push(entry);
      }
    }
    const groupIds = new Set(switches.map((entry) => entry.groupId));
    for (const group of routing.groups) {
      if (groupIds.has(group.id)) continue;
      sceneChanged = true;
      switches.push({ groupId: group.id, activeLaneId: group.activeLaneId });
    }

    if (!sceneChanged) return scene;
    changed = true;
    return { ...scene, modules, lanes, switches };
  });

  return changed ? { scenes: next, changed: true } : { scenes, changed: false };
}

/** Validates persisted scene data (rig files, session snapshots); anything
    malformed rejects the whole array so callers can degrade to "no scenes". */
export function isSceneArray(value: unknown): value is Scene[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s: unknown) =>
        isRecord(s) &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        isModuleStateArray(s.modules) &&
        isLaneStateArray(s.lanes) &&
        isSwitchStateArray(s.switches),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModuleStateArray(value: unknown): value is SceneModuleState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m: unknown) =>
        isRecord(m) &&
        typeof m.moduleId === 'string' &&
        typeof m.bypassed === 'boolean' &&
        Array.isArray(m.params) &&
        m.params.every(
          (p: unknown) =>
            isRecord(p) && typeof p.paramIndex === 'number' && typeof p.value === 'number',
        ),
    )
  );
}

function isLaneStateArray(value: unknown): value is SceneLaneState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (l: unknown) =>
        isRecord(l) &&
        typeof l.laneId === 'string' &&
        typeof l.gain === 'number' &&
        typeof l.pan === 'number' &&
        typeof l.muted === 'boolean' &&
        typeof l.soloed === 'boolean',
    )
  );
}

function isSwitchStateArray(value: unknown): value is SceneSwitchState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s: unknown) =>
        isRecord(s) &&
        typeof s.groupId === 'string' &&
        (s.activeLaneId === undefined || typeof s.activeLaneId === 'string'),
    )
  );
}
