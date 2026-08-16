import type { RackModule, RoutingState, Scene } from './types';
import { SCENE_VALUE_EPSILON } from './scenes';

/** Snap a normalised value onto the scene-epsilon grid, so a signature survives
    the engine's float32 echo round-trip (~6e-8) while a real edit (> epsilon)
    still lands on a different grid point.

    This is NOT equivalent to `sceneMatchesLive`'s epsilon comparison, and no
    canonicalisation could be: "within epsilon" is not transitive, so it cannot
    be expressed as equality of any bucketing. The residual case is a value
    sitting within float32 error of a bucket boundary (an odd multiple of
    SCENE_VALUE_EPSILON / 2) — its optimistic and echoed forms then land on
    different grid points and the rig reports a false unsaved change until the
    next real edit or save. Rare (the two forms only coexist when a baseline is
    snapshotted between an optimistic write and its echo), self-inflicted only
    on the dirty dot, and cheap in exchange for a single string compare. */
const quant = (v: number) => Math.round(v / SCENE_VALUE_EPSILON);

/** The parsed shape of a rigSignature() string, for the discard-path check.
    `value`, `gain` and `pan` hold grid units (already quantised); a meter's
    `value` key is absent entirely (JSON.stringify drops `undefined`). */
interface ParsedSignature {
  rack: Array<
    {
      id: string;
      bypassed: boolean;
      params: Array<{ paramIndex: number; value?: number } & Record<string, unknown>>;
    } & Record<string, unknown>
  >;
  routing: Array<
    {
      id: string;
      activeLaneId?: string;
      lanes: Array<
        {
          id: string;
          gain: number;
          pan: number;
          muted: boolean;
          soloed: boolean;
        } & Record<string, unknown>
      >;
    } & Record<string, unknown>
  >;
  scenes: unknown;
}

/** Whether discarding unsaved changes can skip the full rig reload (plugin
    teardown + re-instantiation, output muted) and instead re-apply `scene` —
    the gapless batched-writes path. True only when that provably restores
    `baseline`: the drift is confined to fields a scene apply can write back
    (knob values, bypass, lane mix, switch selection), and the scene's stored
    values match the baseline for everything the baseline tracks. The caller
    must separately rule out plugin-internal drift (toneDirty), which neither
    the signature nor a scene can see. A malformed signature reports false —
    the full reload is always a safe fallback. */
export function canRevertViaScene(baseline: string, current: string, scene: Scene): boolean {
  try {
    const a = JSON.parse(baseline) as ParsedSignature;
    const b = JSON.parse(current) as ParsedSignature;
    return sceneOnlyDrift(a, b) && sceneRestoresBaseline(scene, a);
  } catch {
    return false;
  }
}

/** Deep-equal of two parsed signatures after masking the scene-recoverable
    fields (bypass, knob values, lane gain/pan/mute/solo, switch selection).
    Everything else — module list and order, names, colors, knob mappings,
    MIDI, lane topology, and the stored scenes themselves — must be identical,
    or the drift is structural and only a full reload can revert it. */
function sceneOnlyDrift(a: ParsedSignature, b: ParsedSignature): boolean {
  const strip = (sig: ParsedSignature) =>
    JSON.stringify({
      rack: sig.rack.map(({ bypassed: _b, params, ...m }) => ({
        ...m,
        params: params.map(({ value: _v, ...p }) => p),
      })),
      routing: sig.routing.map(({ activeLaneId: _a, lanes, ...g }) => ({
        ...g,
        lanes: lanes.map(({ gain: _g, pan: _p, muted: _m, soloed: _s, ...l }) => l),
      })),
      scenes: sig.scenes,
    });
  return strip(a) === strip(b);
}

/** Whether applying `scene` writes the baseline back for every field the
    baseline tracks: each module's bypass and every non-meter knob value, each
    lane's mix, each group's switch. Coverage is checked, not assumed —
    `reconcileScenes` backfills param entries only once their value has been
    echoed, so a scene can transiently lack an entry the apply would then
    silently skip. */
function sceneRestoresBaseline(scene: Scene, baseline: ParsedSignature): boolean {
  const entries = new Map(scene.modules.map((e) => [e.moduleId, e]));
  for (const module of baseline.rack) {
    const entry = entries.get(module.id);
    if (!entry || entry.bypassed !== module.bypassed) return false;
    const stored = new Map(entry.params.map((p) => [p.paramIndex, quant(p.value)]));
    for (const p of module.params) {
      if (p.value === undefined) continue; // meter — a live readout, not a setting
      if (stored.get(p.paramIndex) !== p.value) return false;
    }
  }

  const lanes = new Map(scene.lanes.map((l) => [l.laneId, l]));
  const switches = new Map(scene.switches.map((s) => [s.groupId, s.activeLaneId ?? undefined]));
  for (const group of baseline.routing) {
    if (!switches.has(group.id)) return false;
    if (switches.get(group.id) !== (group.activeLaneId ?? undefined)) return false;
    for (const lane of group.lanes) {
      const s = lanes.get(lane.id);
      if (!s) return false;
      if (quant(s.gain) !== lane.gain || quant(s.pan) !== lane.pan) return false;
      if (s.muted !== lane.muted || s.soloed !== lane.soloed) return false;
    }
  }

  return true;
}

/** The rig's dirty-tracking signature: a stable serialisation of everything a
    rig save would persist, and nothing else. Engine-derived echo fields — knob
    `text` (the plugin's own value formatting, which diverges from the
    table-approximated optimistic text), `valueStrings`/`isBoolean` parameter
    metadata, `availableParams`, `pluginVersion`/`pluginManufacturer` (absent
    during deep standby) — and live meter readouts are all excluded: they
    change without any user edit. */
export function rigSignature(rack: RackModule[], routing: RoutingState, scenes: Scene[]): string {
  return JSON.stringify({
    rack: rack.map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.displayName,
      color: m.color,
      styleVariant: m.styleVariant,
      icon: m.icon,
      texture: m.texture,
      bypassed: m.bypassed,
      laneId: m.laneId,
      midi: m.midi,
      params: m.params.map((p) => ({
        knobId: p.knobId,
        paramIndex: p.paramIndex,
        label: p.label,
        // A meter's value is a live readout, not a setting.
        value: p.isMeter ? undefined : quant(p.value),
        isMeter: p.isMeter,
        meterBipolar: p.meterBipolar,
        pos: p.pos,
        midi: p.midi,
      })),
    })),
    routing: routing.groups.map((g) => ({
      id: g.id,
      position: g.position,
      activeLaneId: g.activeLaneId,
      lanes: g.lanes.map((l) => ({
        id: l.id,
        name: l.name,
        gain: quant(l.gain),
        pan: quant(l.pan),
        muted: l.muted,
        soloed: l.soloed,
        midi: l.midi,
      })),
    })),
    scenes: scenes.map((s) => ({
      id: s.id,
      name: s.name,
      modules: s.modules.map((e) => ({
        moduleId: e.moduleId,
        bypassed: e.bypassed,
        params: e.params.map((p) => ({ paramIndex: p.paramIndex, value: quant(p.value) })),
      })),
      lanes: s.lanes.map((l) => ({
        laneId: l.laneId,
        gain: quant(l.gain),
        pan: quant(l.pan),
        muted: l.muted,
        soloed: l.soloed,
      })),
      switches: s.switches.map((sw) => ({ groupId: sw.groupId, activeLaneId: sw.activeLaneId })),
    })),
  });
}
