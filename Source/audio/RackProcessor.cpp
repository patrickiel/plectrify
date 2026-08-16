#include "RackProcessor.h"

#include <algorithm>
#include <atomic>

using AudioGraphIOProcessor = juce::AudioProcessorGraph::AudioGraphIOProcessor;
using NodeID = juce::AudioProcessorGraph::NodeID;

namespace
{
    /** Real-time-safe terminal processor for one parallel lane. The atomics
        are targets; each block ramps the applied per-channel gains toward
        them, so scene switches, lane switches, and mix drags land without
        clicks. */
    class LaneMixProcessor final : public PassthroughProcessor
    {
    public:
        LaneMixProcessor() : PassthroughProcessor ("Lane Mix") {}

        void setMix (float newGain, float newPan, bool audible) noexcept
        {
            gain.store (audible ? juce::jmax (0.0f, newGain) : 0.0f);
            pan.store (juce::jlimit (-1.0f, 1.0f, newPan));
        }

        void prepareToPlay (double, int) override { snap = true; }

        void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
        {
            const auto g = gain.load();
            const auto p = pan.load();
            const float targetLeft  = g * (p > 0.0f ? 1.0f - p : 1.0f);
            const float targetRight = g * (p < 0.0f ? 1.0f + p : 1.0f);
            if (snap)
            {
                currentLeft = targetLeft;
                currentRight = targetRight;
                snap = false;
            }
            buffer.applyGainRamp (0, 0, buffer.getNumSamples(), currentLeft, targetLeft);
            buffer.applyGainRamp (1, 0, buffer.getNumSamples(), currentRight, targetRight);
            currentLeft = targetLeft;
            currentRight = targetRight;
        }
        void processBlock (juce::AudioBuffer<double>& buffer, juce::MidiBuffer&) override
        {
            const auto g = gain.load();
            const auto p = pan.load();
            const float targetLeft  = g * (p > 0.0f ? 1.0f - p : 1.0f);
            const float targetRight = g * (p < 0.0f ? 1.0f + p : 1.0f);
            if (snap)
            {
                currentLeft = targetLeft;
                currentRight = targetRight;
                snap = false;
            }
            buffer.applyGainRamp (0, 0, buffer.getNumSamples(), (double) currentLeft, (double) targetLeft);
            buffer.applyGainRamp (1, 0, buffer.getNumSamples(), (double) currentRight, (double) targetRight);
            currentLeft = targetLeft;
            currentRight = targetRight;
        }

    private:
        std::atomic<float> gain { 1.0f };
        std::atomic<float> pan { 0.0f };
        // Audio-thread-only ramp state; snapped to the targets on prepare.
        float currentLeft = 1.0f;
        float currentRight = 1.0f;
        bool snap = true;
    };

    /** Placeholder node for a missing slot (see RackProcessor::addMissingPlugin):
        processing leaves the buffer untouched, so the slot passes audio straight
        through — audibly identical to a bypassed slot. */
    class MissingPluginProcessor final : public PassthroughProcessor
    {
    public:
        explicit MissingPluginProcessor (juce::String name) : PassthroughProcessor (std::move (name)) {}
        void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}
        void processBlock (juce::AudioBuffer<double>&, juce::MidiBuffer&) override {}
    };

    /** A node's real audio channel counts — {0, 0} for a node that has gone.
        Routing reads these instead of assuming stereo: the graph leaves a
        hosted plugin's bus layout exactly as the plugin declared it. */
    struct ChannelCounts { int ins = 0, outs = 0; };

    ChannelCounts channelsOf (const juce::AudioProcessorGraph& graph, NodeID nodeID)
    {
        if (auto* node = graph.getNodeForId (nodeID))
            if (auto* processor = node->getProcessor())
                return { processor->getTotalNumInputChannels(), processor->getTotalNumOutputChannels() };

        return {};
    }
}

RackProcessor::RackProcessor()
{
    // Stereo in / stereo out. The AudioProcessorPlayer drives the graph and
    // adapts the real device channel count to this layout.
    graph.setPlayConfigDetails (2, 2, 44100.0, 512);

    audioInputNode = graph.addNode (
        std::make_unique<AudioGraphIOProcessor> (AudioGraphIOProcessor::audioInputNode));
    audioOutputNode = graph.addNode (
        std::make_unique<AudioGraphIOProcessor> (AudioGraphIOProcessor::audioOutputNode));

    auto router = std::make_unique<InputRouterProcessor>();
    inputRouter = router.get();
    inputRouterNode = graph.addNode (std::move (router));
    auto output = std::make_unique<OutputLevelProcessor>();
    outputLevel = output.get();
    outputLevelNode = graph.addNode (std::move (output));
    auto looperProcessor = std::make_unique<LooperProcessor>();
    looper = looperProcessor.get();
    looperNode = graph.addNode (std::move (looperProcessor));
    auto metronomeProcessor = std::make_unique<MetronomeProcessor>();
    metronome = metronomeProcessor.get();
    metronomeNode = graph.addNode (std::move (metronomeProcessor));

    rebuildConnections();
}

RackProcessor::~RackProcessor()
{
    graph.clear();
}

int RackProcessor::indexOf (NodeID nodeID) const
{
    for (int i = 0; i < (int) slots.size(); ++i)
        if (slots[(size_t) i].nodeID == nodeID)
            return i;

    return -1;
}

NodeID RackProcessor::addPlugin (std::unique_ptr<juce::AudioPluginInstance> instance, int index,
                                 const juce::String& clientId,
                                 std::optional<int> serialPosition,
                                 const juce::String& beforeGroupId)
{
    jassert (instance != nullptr);

    const juce::String name = instance->getName();

    // Suspension alone brackets the edit: the device callback checks the
    // suspended flag under the callback lock and emits silence. Holding that
    // lock across addNode would instead block the audio thread for the whole
    // duration of the new plugin's prepareToPlay (heavy for IR loaders).
    graph.suspendProcessing (true);
    const auto node = graph.addNode (std::move (instance));

    const int clamped = juce::jlimit (0, (int) slots.size(), index);
    slots.insert (slots.begin() + clamped, Slot { node->nodeID, clientId, name, false, {} });

    if (serialPosition.has_value())
    {
        const int position = juce::jmax (0, *serialPosition);
        const auto before = beforeGroupId.isNotEmpty()
            ? std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& group)
              {
                  return group.id == beforeGroupId;
              })
            : groups.end();
        for (auto group = groups.begin(); group != groups.end(); ++group)
            if (group->position > position
                || (group->position == position && before != groups.end() && group >= before))
                ++group->position;
    }

    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
    return node->nodeID;
}

NodeID RackProcessor::addMissingPlugin (const juce::String& clientId, const juce::String& name,
                                        const juce::String& descriptionXml, const juce::String& stateBase64,
                                        int index)
{
    // Same suspend/rebuild bracket as addPlugin — the placeholder is a real
    // node in the chain, just one that passes audio straight through.
    graph.suspendProcessing (true);
    const auto node = graph.addNode (std::make_unique<MissingPluginProcessor> (name));

    const int clamped = juce::jlimit (0, (int) slots.size(), index);
    Slot slot { node->nodeID, clientId, name, false, {} };
    slot.missing = true;
    slot.missingDescription = descriptionXml;
    slot.missingState = stateBase64;
    slots.insert (slots.begin() + clamped, std::move (slot));

    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
    return node->nodeID;
}

void RackProcessor::removePlugin (NodeID nodeID)
{
    const int idx = indexOf (nodeID);
    if (idx < 0)
        return;

    const auto removedLaneId = slots[(size_t) idx].laneId;
    const bool removesLastLanePlugin = removedLaneId.isNotEmpty()
        && std::count_if (slots.begin(), slots.end(), [&] (const Slot& slot)
        {
            return slot.laneId == removedLaneId;
        }) == 1;

    if (removedLaneId.isEmpty())
    {
        const int serialIndex = (int) std::count_if (slots.begin(), slots.begin() + idx,
            [] (const Slot& slot) { return slot.laneId.isEmpty(); });
        for (auto& group : groups)
            if (group.position > serialIndex)
                --group.position;
    }

    graph.suspendProcessing (true);
    slots.erase (slots.begin() + idx);
    graph.removeNode (nodeID);

    // A lane without any plugin has no signal-path meaning. Removing its last
    // plugin removes the lane too; a two-lane split consequently collapses
    // back into the serial chain.
    if (removesLastLanePlugin)
    {
        auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
        {
            return std::any_of (item.lanes.begin(), item.lanes.end(), [&] (const Lane& lane)
            {
                return lane.id == removedLaneId;
            });
        });

        if (group != groups.end())
        {
            if (group->lanes.size() <= 2)
            {
                const int restored = (int) std::count_if (slots.begin(), slots.end(), [&] (const Slot& slot)
                {
                    return std::any_of (group->lanes.begin(), group->lanes.end(), [&] (const Lane& lane)
                    {
                        return lane.id == slot.laneId;
                    });
                });
                for (auto& slot : slots)
                    if (std::any_of (group->lanes.begin(), group->lanes.end(), [&] (const Lane& lane)
                    {
                        return lane.id == slot.laneId;
                    }))
                        slot.laneId.clear();
                for (auto after = group + 1; after != groups.end(); ++after)
                    after->position += restored;
                for (const auto& lane : group->lanes)
                    graph.removeNode (lane.mixNode->nodeID);
                groups.erase (group);
            }
            else
            {
                auto lane = std::find_if (group->lanes.begin(), group->lanes.end(), [&] (const Lane& item)
                {
                    return item.id == removedLaneId;
                });
                graph.removeNode (lane->mixNode->nodeID);
                group->lanes.erase (lane);
                if (group->activeLaneId == removedLaneId)
                    group->activeLaneId = group->lanes.front().id;
            }
        }
    }

    updateLaneProcessors();
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::movePlugin (int fromIndex, int toIndex)
{
    const int count = (int) slots.size();
    if (fromIndex < 0 || fromIndex >= count)
        return;

    toIndex = juce::jlimit (0, count - 1, toIndex);
    if (fromIndex == toIndex)
        return;

    graph.suspendProcessing (true);
    Slot moved = slots[(size_t) fromIndex];
    slots.erase (slots.begin() + fromIndex);
    slots.insert (slots.begin() + toIndex, moved);
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::moveSlot (const juce::String& clientId, const MoveTarget& target)
{
    // Mirrors moveModuleInRack() in ui/src/lib/engine/rackMove.ts — keep the
    // two in step. Everything is validated and resolved before suspending, so
    // an invalid target or a no-op drop never interrupts audio.
    const int count = (int) slots.size();
    int from = -1;
    for (int i = 0; i < count; ++i)
        if (slots[(size_t) i].clientId == clientId)
        {
            from = i;
            break;
        }
    if (from < 0)
        return;
    // "Before yourself" is a no-op by definition — and the anchor would
    // vanish once the slot is detached.
    if (target.beforeModuleId == clientId)
        return;

    const bool toNewLane = target.newLaneGroupId.isNotEmpty();
    auto destGroup = groups.end();
    if (toNewLane)
    {
        destGroup = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
        {
            return item.id == target.newLaneGroupId;
        });
        if (destGroup == groups.end() || target.newLaneId.isEmpty())
            return;
        // addLane's rule: a lane id must be globally unused.
        for (const auto& item : groups)
            if (std::any_of (item.lanes.begin(), item.lanes.end(),
                             [&] (const Lane& lane) { return lane.id == target.newLaneId; }))
                return;
    }

    const juce::String destLane = toNewLane ? target.newLaneId : target.laneId;
    if (! toNewLane && destLane.isNotEmpty())
    {
        const bool laneExists = std::any_of (groups.begin(), groups.end(), [&] (const SplitGroup& item)
        {
            return std::any_of (item.lanes.begin(), item.lanes.end(),
                                [&] (const Lane& lane) { return lane.id == destLane; });
        });
        if (! laneExists)
            return;
    }

    const juce::String oldLaneId = slots[(size_t) from].laneId;
    const int oldSerialIndex = oldLaneId.isEmpty()
        ? (int) std::count_if (slots.begin(), slots.begin() + from,
                               [] (const Slot& slot) { return slot.laneId.isEmpty(); })
        : -1;
    const int serialCountPre = (int) std::count_if (slots.begin(), slots.end(),
        [] (const Slot& slot) { return slot.laneId.isEmpty(); });

    // --- Semantic no-op detection, before any mutation --------------------
    // Flat indices are not a reliable no-op test: lane slots interleave with
    // serial slots in the flat array, so a drop into the slot's own logical
    // gap can resolve to a different flat index (which would commit a move
    // that corrupts group positions and shuffles the flat order) while a real
    // move across an adjacent split can resolve to the slot's own index
    // (which would be swallowed). Classify by signal-path meaning instead.
    // Mirrored in rackMove.ts — keep both sides in step.
    if (! toNewLane)
    {
        if (oldLaneId.isEmpty() && target.laneId.isEmpty())
        {
            const int p = juce::jlimit (0, serialCountPre,
                                        target.serialPosition.value_or (serialCountPre));
            // The gap directly before the slot (or after a split directly
            // before it). With beforeGroupId the drop crosses that split — a
            // real move.
            if (p == oldSerialIndex && target.beforeGroupId.isEmpty())
                return;
            if (p == oldSerialIndex + 1)
            {
                const SplitGroup* firstFollower = nullptr;
                for (const auto& group : groups)
                    if (group.position == p) { firstFollower = &group; break; }
                // The gap directly after the slot: plain when no split
                // follows, or naming the directly-following split it stops
                // short of. Without beforeGroupId while a split IS there, the
                // drop means the split's far side — a real move.
                if (target.beforeGroupId.isEmpty() && firstFollower == nullptr)
                    return;
                if (target.beforeGroupId.isNotEmpty() && firstFollower != nullptr
                    && firstFollower->id == target.beforeGroupId)
                    return;
            }
        }
        else if (oldLaneId.isNotEmpty() && target.laneId == oldLaneId)
        {
            juce::String successor;
            for (int i = from + 1; i < count; ++i)
                if (slots[(size_t) i].laneId == oldLaneId)
                {
                    successor = slots[(size_t) i].clientId;
                    break;
                }
            // The end-of-lane gap under the last slot, or the gap before the
            // slot's own successor.
            if (target.beforeModuleId.isEmpty() && successor.isEmpty())
                return;
            if (target.beforeModuleId.isNotEmpty() && successor == target.beforeModuleId)
                return;
        }
    }

    // Resolve the destination against the detached order (slot `from`
    // skipped) without touching `slots` yet; `insertAt` is a detached index,
    // defaulting to the end of the detached array.
    int insertAt = count - 1;
    int pos = 0;
    if (destLane.isNotEmpty())
    {
        if (target.beforeModuleId.isNotEmpty())
        {
            int detachedIndex = 0;
            for (int i = 0; i < count; ++i)
            {
                if (i == from)
                    continue;
                const auto& slot = slots[(size_t) i];
                if (slot.clientId == target.beforeModuleId && slot.laneId == destLane)
                {
                    insertAt = detachedIndex;
                    break;
                }
                ++detachedIndex;
            }
        }
    }
    else
    {
        // Pre-move → detached coordinates: serial gaps past the slot's old
        // spot shift down by one once it is detached.
        const int serialCount = serialCountPre - (oldLaneId.isEmpty() ? 1 : 0);
        pos = target.serialPosition.value_or (serialCount);
        if (oldLaneId.isEmpty() && pos > oldSerialIndex)
            --pos;
        pos = juce::jlimit (0, serialCount, pos);

        int serialSeen = 0, detachedIndex = 0;
        for (int i = 0; i < count; ++i)
        {
            if (i == from)
                continue;
            if (slots[(size_t) i].laneId.isEmpty())
            {
                if (serialSeen == pos)
                {
                    insertAt = detachedIndex;
                    break;
                }
                ++serialSeen;
            }
            ++detachedIndex;
        }
    }

    graph.suspendProcessing (true);

    // A fresh lane is born inside the same bracket — this is why moveSlot
    // exists instead of composing addLane with a second topology edit.
    if (toNewLane)
        destGroup->lanes.push_back ({ target.newLaneId, graph.addNode (std::make_unique<LaneMixProcessor>()) });

    Slot moved = slots[(size_t) from];
    moved.laneId = destLane;
    slots.erase (slots.begin() + from);

    // Mirror removePlugin: a serial slot leaving the chain takes one
    // preceding module away from every later group…
    if (oldLaneId.isEmpty())
        for (auto& group : groups)
            if (group.position > oldSerialIndex)
                --group.position;

    slots.insert (slots.begin() + insertAt, moved);

    // …and mirror addPlugin for the serial re-entry fixups.
    if (destLane.isEmpty())
    {
        const auto before = target.beforeGroupId.isNotEmpty()
            ? std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& group)
              {
                  return group.id == target.beforeGroupId;
              })
            : groups.end();
        for (auto group = groups.begin(); group != groups.end(); ++group)
            if (group->position > pos
                || (group->position == pos && before != groups.end() && group >= before))
                ++group->position;
    }

    // Unlike removePlugin, a lane emptied by the move stays: empty lanes are
    // a legal state (createSplit mints one), and dragging a module out must
    // never silently dissolve a split.

    updateLaneProcessors();
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::swapSlots (const juce::String& clientIdA, const juce::String& clientIdB)
{
    // Mirrors swapModulesInRack() in ui/src/lib/engine/rackMove.ts — keep the
    // two in step. Validated before suspending, so a stale id never interrupts
    // audio.
    if (clientIdA == clientIdB)
        return;

    const int count = (int) slots.size();
    int a = -1, b = -1;
    for (int i = 0; i < count; ++i)
    {
        const auto& id = slots[(size_t) i].clientId;
        if (id == clientIdA) a = i;
        else if (id == clientIdB) b = i;
    }
    if (a < 0 || b < 0)
        return;

    graph.suspendProcessing (true);

    // The two *places* keep their lane membership; only what sits in them
    // changes hands. So a serial slot traded with one inside a lane really
    // does enter that lane, while the flat array's tag sequence — and with it
    // every group's position — reads exactly as it did before. Nothing to fix
    // up, and no lane can be emptied or born by a swap.
    std::swap (slots[(size_t) a], slots[(size_t) b]);
    std::swap (slots[(size_t) a].laneId, slots[(size_t) b].laneId);

    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::setBypassed (NodeID nodeID, bool shouldBypass)
{
    // Bypass is not topological: the slot stays wired and the graph's render
    // sequence checks the node's atomic bypass flag per block, running the
    // plugin's latency-compensated passthrough instead of its DSP. No
    // suspension, no rebuild — a bypass toggle is gapless.
    const int idx = indexOf (nodeID);
    if (idx < 0 || slots[(size_t) idx].bypassed == shouldBypass)
        return;

    slots[(size_t) idx].bypassed = shouldBypass;
    if (auto* node = graph.getNodeForId (nodeID))
        node->setBypassed (shouldBypass);
    ++revision;
}

bool RackProcessor::setBypassedBatch (const std::vector<std::pair<juce::String, bool>>& byClientId)
{
    bool changed = false;
    for (const auto& [clientId, shouldBypass] : byClientId)
        for (auto& slot : slots)
            if (slot.clientId == clientId && slot.bypassed != shouldBypass)
            {
                slot.bypassed = shouldBypass;
                if (auto* node = graph.getNodeForId (slot.nodeID))
                    node->setBypassed (shouldBypass);
                changed = true;
            }

    if (changed)
        ++revision;
    return changed;
}

bool RackProcessor::applyPluginState (const juce::String& clientId, const juce::MemoryBlock& state)
{
    auto slot = std::find_if (slots.begin(), slots.end(),
                              [&] (const Slot& s) { return s.clientId == clientId; });
    if (slot == slots.end())
        return false;

    if (slot->missing)
    {
        // No instance to write to. Keeping the blob verbatim is what lets a
        // patch applied to a placeholder survive until the plugin is back.
        slot->missingState = juce::Base64::toBase64 (state.getData(), state.getSize());
        return true;
    }

    auto* instance = getPluginInstance (slot->nodeID);
    if (instance == nullptr)
        return false;

    // Per-node rather than graph.suspendProcessing(): setStateInformation can
    // do file I/O (a capture, an impulse response) and block for hundreds of
    // milliseconds. Suspending the whole graph for that long is a dropout of
    // the entire rig; suspending one node silences exactly the plugin whose
    // sound is being replaced anyway.
    instance->suspendProcessing (true);
    instance->setStateInformation (state.getData(), (int) state.getSize());
    // Not a bare suspendProcessing (false): standby may have engaged during a
    // slow load, and updateSuspendedStates() is the single owner of that flag,
    // so going through it honours standby instead of silently waking the node.
    updateSuspendedStates();
    return true;
}

void RackProcessor::refreshLatencyCompensation()
{
    // Reconnecting an identical topology still marks the graph dirty, which
    // rebuilds the render sequence with the plugins' current latencies.
    graph.suspendProcessing (true);
    rebuildConnections();
    graph.suspendProcessing (false);
}

void RackProcessor::createSplit (const juce::String& groupId, const juce::String& atClientId, int groupPosition,
                                 const juce::StringArray& laneIds, const juce::String& activeLaneId)
{
    if (groupId.isEmpty() || laneIds.size() < 2 || std::any_of (groups.begin(), groups.end(),
        [&] (const SplitGroup& group) { return group.id == groupId; }))
        return;

    for (const auto& id : laneIds)
    {
        if (id.isEmpty())
            return;
        for (const auto& group : groups)
            if (std::any_of (group.lanes.begin(), group.lanes.end(),
                [&] (const Lane& lane) { return lane.id == id; }))
                return;
    }

    graph.suspendProcessing (true);
    SplitGroup group;
    group.id = groupId;
    group.position = juce::jmax (0, groupPosition);
    // A lane id from outside this group would mute every lane, so an unknown
    // one falls back to the parallel sum.
    if (laneIds.contains (activeLaneId))
        group.activeLaneId = activeLaneId;
    for (const auto& id : laneIds)
        group.lanes.push_back ({ id, graph.addNode (std::make_unique<LaneMixProcessor>()) });

    auto insertAt = std::find_if (groups.begin(), groups.end(), [groupPosition] (const SplitGroup& item)
    {
        return item.position > groupPosition;
    });
    for (auto it = insertAt; it != groups.end(); ++it)
        --it->position;
    groups.insert (insertAt, std::move (group));

    if (atClientId.isNotEmpty())
        for (auto& slot : slots)
            if (slot.clientId == atClientId)
            {
                slot.laneId = laneIds[0];
                break;
            }

    updateLaneProcessors();
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

bool RackProcessor::addLane (const juce::String& groupId, const juce::String& laneId)
{
    auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
    {
        return item.id == groupId;
    });
    if (group == groups.end() || laneId.isEmpty())
        return false;
    for (const auto& item : groups)
        if (std::any_of (item.lanes.begin(), item.lanes.end(), [&] (const Lane& lane) { return lane.id == laneId; }))
            return false;
    graph.suspendProcessing (true);
    auto node = graph.addNode (std::make_unique<LaneMixProcessor>());
    group->lanes.push_back ({ laneId, node });
    updateLaneProcessors();
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
    return true;
}

void RackProcessor::removeLane (const juce::String& laneId)
{
    auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
    {
        return std::any_of (item.lanes.begin(), item.lanes.end(), [&] (const Lane& lane) { return lane.id == laneId; });
    });
    if (group == groups.end())
        return;

    graph.suspendProcessing (true);
    // A removed lane takes its modules with it: the user is deleting a branch,
    // not rerouting it, so nothing falls back into the serial chain. Lane slots
    // never count toward a group's position, so no split arithmetic moves.
    for (auto slot = slots.begin(); slot != slots.end();)
        if (slot->laneId == laneId)
        {
            graph.removeNode (slot->nodeID);
            slot = slots.erase (slot);
        }
        else
            ++slot;

    if (group->lanes.size() <= 2)
    {
        // Down to one lane there is nothing left to split: the group dissolves,
        // and only the *surviving* lane's modules return to the serial chain
        // (the doomed lane's slots are already gone). dissolveSplit rebuilds
        // the connections and resumes processing itself.
        const auto groupId = group->id;
        dissolveSplit (groupId);
        return;
    }
    auto it = std::find_if (group->lanes.begin(), group->lanes.end(), [&] (const Lane& lane) { return lane.id == laneId; });
    graph.removeNode (it->mixNode->nodeID);
    group->lanes.erase (it);
    if (group->activeLaneId == laneId)
        group->activeLaneId = group->lanes.front().id;
    updateLaneProcessors();
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::moveLane (const juce::String& laneId, int toIndex)
{
    auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
    {
        return std::any_of (item.lanes.begin(), item.lanes.end(), [&] (const Lane& lane) { return lane.id == laneId; });
    });
    if (group == groups.end())
        return;
    auto& lanes = group->lanes;
    const auto from = (int) std::distance (lanes.begin(),
        std::find_if (lanes.begin(), lanes.end(), [&] (const Lane& lane) { return lane.id == laneId; }));
    const auto to = juce::jlimit (0, (int) lanes.size() - 1, toIndex);
    if (from == to)
        return;

    graph.suspendProcessing (true);
    // Lane order carries no audio meaning — every lane hangs off the same split
    // junction and sums at the same merge — so the connection set is unchanged
    // and only the published order has to move.
    if (from < to)
        std::rotate (lanes.begin() + from, lanes.begin() + from + 1, lanes.begin() + to + 1);
    else
        std::rotate (lanes.begin() + to, lanes.begin() + from, lanes.begin() + from + 1);
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::movePluginToLane (const juce::String& clientId, const juce::String& laneId)
{
    if (laneId.isNotEmpty())
    {
        bool found = false;
        for (const auto& group : groups)
            found = found || std::any_of (group.lanes.begin(), group.lanes.end(),
                [&] (const Lane& lane) { return lane.id == laneId; });
        if (! found)
            return;
    }
    for (auto& slot : slots)
        if (slot.clientId == clientId)
        {
            if (slot.laneId == laneId)
                return;
            graph.suspendProcessing (true);
            slot.laneId = laneId;
            rebuildConnections();
            ++revision;
            graph.suspendProcessing (false);
            return;
        }
}

void RackProcessor::setLaneMix (const juce::String& laneId, std::optional<float> gain,
                                std::optional<float> pan, std::optional<bool> muted,
                                std::optional<bool> soloed)
{
    for (auto& group : groups)
        for (auto& lane : group.lanes)
            if (lane.id == laneId)
            {
                const auto nextGain = gain ? juce::jlimit (0.0f, 2.0f, *gain) : lane.gain;
                const auto nextPan = pan ? juce::jlimit (-1.0f, 1.0f, *pan) : lane.pan;
                const auto nextMuted = muted.value_or (lane.muted);
                const auto nextSoloed = soloed.value_or (lane.soloed);
                if (nextGain == lane.gain && nextPan == lane.pan
                    && nextMuted == lane.muted && nextSoloed == lane.soloed)
                    return;
                lane.gain = nextGain;
                lane.pan = nextPan;
                lane.muted = nextMuted;
                lane.soloed = nextSoloed;
                updateLaneProcessors();
                ++revision;
                return;
            }
}

void RackProcessor::setLaneSwitch (const juce::String& groupId, const juce::String& activeLaneId)
{
    auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
    {
        return item.id == groupId;
    });
    if (group == groups.end())
        return;
    if (activeLaneId.isNotEmpty() && ! std::any_of (group->lanes.begin(), group->lanes.end(),
        [&] (const Lane& lane) { return lane.id == activeLaneId; }))
        return;
    if (group->activeLaneId == activeLaneId)
        return;

    group->activeLaneId = activeLaneId;
    updateLaneProcessors();
    ++revision;
}

void RackProcessor::dissolveSplit (const juce::String& groupId)
{
    auto group = std::find_if (groups.begin(), groups.end(), [&] (const SplitGroup& item)
    {
        return item.id == groupId;
    });
    if (group == groups.end())
        return;

    graph.suspendProcessing (true);
    const int restored = (int) std::count_if (slots.begin(), slots.end(), [&] (const Slot& slot)
    {
        return std::any_of (group->lanes.begin(), group->lanes.end(), [&] (const Lane& lane) { return lane.id == slot.laneId; });
    });
    for (auto& slot : slots)
        if (std::any_of (group->lanes.begin(), group->lanes.end(), [&] (const Lane& lane) { return lane.id == slot.laneId; }))
            slot.laneId.clear();
    for (auto after = group + 1; after != groups.end(); ++after)
        after->position += restored;
    for (const auto& lane : group->lanes)
        graph.removeNode (lane.mixNode->nodeID);
    groups.erase (group);
    rebuildConnections();
    ++revision;
    graph.suspendProcessing (false);
}

void RackProcessor::dissolveAllSplits()
{
    while (! groups.empty())
        dissolveSplit (groups.back().id);
}

std::vector<RackProcessor::SplitState> RackProcessor::getSplitStates() const
{
    std::vector<SplitState> result;
    result.reserve (groups.size());
    for (const auto& group : groups)
    {
        SplitState state { group.id, group.position, group.activeLaneId, {} };
        state.lanes.reserve (group.lanes.size());
        for (const auto& lane : group.lanes)
            state.lanes.push_back ({ lane.id, lane.gain, lane.pan, lane.muted, lane.soloed });
        result.push_back (std::move (state));
    }
    return result;
}

bool RackProcessor::laneIsAudible (const SplitGroup& group, const Lane& lane) const
{
    const bool anySoloed = std::any_of (group.lanes.begin(), group.lanes.end(),
        [] (const Lane& item) { return item.soloed; });
    return (group.activeLaneId.isEmpty() || group.activeLaneId == lane.id)
        && ! lane.muted && (! anySoloed || lane.soloed);
}

void RackProcessor::updateLaneProcessors()
{
    for (auto& group : groups)
        for (auto& lane : group.lanes)
            if (auto* mix = dynamic_cast<LaneMixProcessor*> (lane.mixNode->getProcessor()))
                mix->setMix (lane.gain, lane.pan, laneIsAudible (group, lane));
}

void RackProcessor::updateSuspendedStates()
{
    // Standby is the only reason to suspend a plugin. Suspension makes the
    // graph clear the node's buffer on its very next block, so it can never
    // silence something that is still audible: the cut would land before any
    // fade could carry it out. Lane audibility is therefore a pure gain gate in
    // LaneMixProcessor, and standby pairs its suspension with the output mute's
    // ramp (MainComponent::enterLightStandby mutes, then suspends 50 ms later).
    //
    // Bypassed slots need no exemption: nothing is suspended while awake, so
    // their passthrough is never broken, and in standby the whole chain is meant
    // to be silent anyway.
    //
    // Deriving the flag here rather than looping over the nodes at the call site
    // is what makes it survive every rebuild — and it is also what lets a
    // deep-standby wake rebuild the entire rack pre-suspended and bring it up
    // together on a single setStandbySuspended(false).
    for (const auto& slot : slots)
        if (auto* node = graph.getNodeForId (slot.nodeID))
            if (auto* processor = node->getProcessor())
                if (processor->isSuspended() != standbySuspended)
                    processor->suspendProcessing (standbySuspended);
}

void RackProcessor::setInputGainDb (float db) { if (inputRouter != nullptr) inputRouter->setGainDb (db); }
float RackProcessor::getInputGainDb() const noexcept { return inputRouter != nullptr ? inputRouter->getGainDb() : 0.0f; }
void RackProcessor::setOutputGainDb (float db) { if (outputLevel != nullptr) outputLevel->setGainDb (db); }
float RackProcessor::getOutputGainDb() const noexcept { return outputLevel != nullptr ? outputLevel->getGainDb() : 0.0f; }
void RackProcessor::setTunerEnabled (bool enabled)
{
    tunerEnabled = enabled;
    updateTunerState();
}
void RackProcessor::setMidiTunerActive (bool active)
{
    midiTunerActive = active;
    updateTunerState();
}
void RackProcessor::updateTunerState()
{
    const auto shouldAnalyse = tunerEnabled || midiTunerActive;
    if (inputRouter != nullptr && inputRouter->isTunerEnabled() != shouldAnalyse)
        inputRouter->setTunerEnabled (shouldAnalyse);
    if (outputLevel != nullptr) outputLevel->setTunerMute (midiTunerActive);
}
void RackProcessor::setLoadMuted (bool muted) { if (outputLevel != nullptr) outputLevel->setLoadMute (muted); }
void RackProcessor::setStandbyMuted (bool muted) { if (outputLevel != nullptr) outputLevel->setStandbyMute (muted); }
void RackProcessor::setFeedbackGuardEnabled (bool enabled) { if (outputLevel != nullptr) outputLevel->setFeedbackGuardEnabled (enabled); }
bool RackProcessor::isFeedbackGuardEnabled() const noexcept { return outputLevel != nullptr && outputLevel->isFeedbackGuardEnabled(); }
void RackProcessor::setFeedbackMuted (bool muted) { if (outputLevel != nullptr) outputLevel->setFeedbackTripped (muted); }
bool RackProcessor::isFeedbackMuted() const noexcept { return outputLevel != nullptr && outputLevel->isFeedbackTripped(); }
void RackProcessor::setUserMuted (bool muted) { if (outputLevel != nullptr) outputLevel->setUserMute (muted); }
bool RackProcessor::isUserMuted() const noexcept { return outputLevel != nullptr && outputLevel->isUserMuted(); }
bool RackProcessor::isOutputMuted() const noexcept { return outputLevel != nullptr && outputLevel->isMuted(); }

void RackProcessor::setStandbySuspended (bool shouldSuspend)
{
    if (standbySuspended == shouldSuspend)
        return;

    standbySuspended = shouldSuspend;

    // Stop feeding the tuner's analysis thread while idle: it is the only DSP
    // that would otherwise keep running with every plugin suspended.
    if (inputRouter != nullptr)
        inputRouter->setStandby (shouldSuspend);

    // No graph.suspendProcessing() bracket: per-node suspension is not a
    // topology edit, the same reason setBypassed() runs gapless. No ++revision
    // either — nothing the UI models has changed, and bumping it would push a
    // rackChanged and drag the UI through a full reconcile plus session save.
    updateSuspendedStates();
}

void RackProcessor::setInputSourceChannel (int channel)
{
    const auto next = juce::jmax (0, channel);
    if (next == inputSourceChannel)
        return;

    // One edge moves, but it is still a topology edit — and the buffer the
    // router is handed changes identity, so the audio thread must not be
    // halfway through a block that assumed the old one.
    graph.suspendProcessing (true);
    inputSourceChannel = next;
    rebuildConnections();
    graph.suspendProcessing (false);
}

void RackProcessor::setLooperPostChain (bool postChain)
{
    if (looperPostChain == postChain)
        return;

    graph.suspendProcessing (true);
    looperPostChain = postChain;
    rebuildConnections();
    graph.suspendProcessing (false);
}

void RackProcessor::looperCommand (LooperProcessor::Command command)
{
    if (looper != nullptr)
        looper->postCommand (command);
}

void RackProcessor::setLooperArmEnabled (bool enabled)
{
    if (looper != nullptr)
        looper->setArmEnabled (enabled);
}

bool RackProcessor::isLooperArmEnabled() const
{
    return looper != nullptr && looper->isArmEnabled();
}

void RackProcessor::setLooperArmThresholdDb (float db)
{
    if (looper != nullptr)
        looper->setArmThresholdDb (db);
}

float RackProcessor::getLooperArmThresholdDb() const
{
    return looper != nullptr ? looper->getArmThresholdDb()
                             : LooperProcessor::defaultArmThresholdDb;
}

LooperProcessor::Status RackProcessor::getLooperStatus() const
{
    return looper != nullptr ? looper->getStatus() : LooperProcessor::Status {};
}

bool RackProcessor::isLooperActive() const
{
    return looper != nullptr && looper->isActive();
}

int RackProcessor::snapshotLooperLoop (juce::AudioBuffer<float>& dest) const
{
    return looper != nullptr ? looper->snapshotLoop (dest) : 0;
}

void RackProcessor::stageLooperLoad (juce::AudioBuffer<float>&& buffer, int lengthSamples)
{
    if (looper != nullptr)
        looper->stageLoadedLoop (std::move (buffer), lengthSamples);
}

bool RackProcessor::isLooperLoadConsumed() const
{
    return looper != nullptr && looper->isStagedLoadConsumed();
}

bool RackProcessor::isLooperLoopUnchangedSinceLoad() const
{
    return looper != nullptr && looper->isLoopUnchangedSinceLoad();
}

double RackProcessor::getLooperSampleRate() const
{
    return looper != nullptr ? looper->getLoopSampleRate() : 0.0;
}

void RackProcessor::metronomeCommand (MetronomeProcessor::Command command)
{
    if (metronome != nullptr)
        metronome->postCommand (command);
}

void RackProcessor::setMetronomeEnabled (bool enabled)
{
    if (metronome != nullptr)
        metronome->setEnabled (enabled);
}

bool RackProcessor::isMetronomeEnabled() const
{
    return metronome != nullptr && metronome->isEnabled();
}

void RackProcessor::setMetronomeBpm (float bpm)
{
    if (metronome != nullptr)
        metronome->setBpm (bpm);
}

float RackProcessor::getMetronomeBpm() const
{
    return metronome != nullptr ? metronome->getBpm() : MetronomeProcessor::defaultBpm;
}

void RackProcessor::setMetronomeBeatsPerBar (int beats)
{
    if (metronome != nullptr)
        metronome->setBeatsPerBar (beats);
}

int RackProcessor::getMetronomeBeatsPerBar() const
{
    return metronome != nullptr ? metronome->getBeatsPerBar()
                                : MetronomeProcessor::defaultBeatsPerBar;
}

void RackProcessor::setMetronomeSubdivision (int subdivision)
{
    if (metronome != nullptr)
        metronome->setSubdivision (subdivision);
}

int RackProcessor::getMetronomeSubdivision() const
{
    return metronome != nullptr ? metronome->getSubdivision() : 1;
}

void RackProcessor::setMetronomeBeatPattern (std::uint64_t pattern)
{
    if (metronome != nullptr)
        metronome->setBeatPattern (pattern);
}

std::uint64_t RackProcessor::getMetronomeBeatPattern() const
{
    return metronome != nullptr ? metronome->getBeatPattern()
                                : MetronomeProcessor::defaultPattern();
}

void RackProcessor::setMetronomeLevelDb (float db)
{
    if (metronome != nullptr)
        metronome->setLevelDb (db);
}

float RackProcessor::getMetronomeLevelDb() const
{
    return metronome != nullptr ? metronome->getLevelDb()
                                : MetronomeProcessor::defaultLevelDb;
}

MetronomeProcessor::Status RackProcessor::getMetronomeStatus() const
{
    return metronome != nullptr ? metronome->getStatus() : MetronomeProcessor::Status {};
}

bool RackProcessor::isMetronomeRunning() const
{
    return metronome != nullptr && metronome->isRunning();
}

float RackProcessor::consumeInputPeak() noexcept { return inputRouter != nullptr ? inputRouter->consumePeak() : 0.0f; }
float RackProcessor::consumeStandbyInputPeak() noexcept { return inputRouter != nullptr ? inputRouter->consumeStandbyPeak() : 0.0f; }
float RackProcessor::consumeOutputPeak() noexcept { return outputLevel != nullptr ? outputLevel->consumePeak() : 0.0f; }
TunerReading RackProcessor::getTunerReading() const { return inputRouter != nullptr ? inputRouter->getTunerReading() : TunerReading {}; }

juce::AudioPluginInstance* RackProcessor::getPluginInstance (NodeID nodeID) const
{
    if (auto* node = graph.getNodeForId (nodeID))
        return dynamic_cast<juce::AudioPluginInstance*> (node->getProcessor());

    return nullptr;
}

bool RackProcessor::passesAudio (NodeID nodeID) const
{
    const auto counts = channelsOf (graph, nodeID);
    return counts.ins > 0 && counts.outs > 0;
}

void RackProcessor::rebuildConnections()
{
    // Every topology change funnels through here, so this is also where the
    // per-plugin suspension state is re-derived over the new slot list — which
    // is what brings a plugin added during standby up already suspended.
    updateSuspendedStates();

    // Wipe every connection, then relink input -> slots -> output as a simple
    // serial chain over both channels. Bypassed slots stay wired: bypass is a
    // per-node flag the render sequence checks each block, not a topology
    // change, so toggling it never suspends audio.
    for (auto& connection : graph.getConnections())
        graph.removeConnection (connection);

    // The rack routes stereo, but a hosted plugin is whatever its own bus
    // layout says — the graph never renegotiates it, and an edge naming a
    // channel the plugin doesn't have is silently dropped, leaving the
    // downstream node fed cleared silence. So wire against the real channel
    // counts: a mono output fans onto both channels (correct here, since the
    // guitar signal is mono to begin with), and a mono input takes the left
    // one. Summing L+R into a mono input would double a correlated signal's
    // gain; a true downmix would need an adapter node and has no use case yet.
    //
    // The graph's own input node is the one exception, and the only edge that
    // reads inputSourceChannel: a guitar is one jack on an interface that may
    // have eight, so that pin — not pin 0 — is what feeds the chain, on both
    // channels. Everything downstream is already stereo (the router fans the
    // mono guitar out), so nothing else has to know. Clamped here rather than
    // on the setter, because the interface can change under a saved choice.
    auto connect = [this] (NodeID from, NodeID to)
    {
        const auto outs = channelsOf (graph, from).outs;
        const auto ins  = channelsOf (graph, to).ins;
        const auto guitarPin = from == audioInputNode->nodeID
                                 ? juce::jlimit (0, juce::jmax (0, outs - 1), inputSourceChannel)
                                 : -1;

        for (int channel = 0; channel < juce::jmin (2, ins); ++channel)
            graph.addConnection ({ { from, guitarPin >= 0 ? guitarPin : juce::jmin (channel, outs - 1) },
                                   { to, channel } });
    };
    auto connectChain = [&connect] (const std::vector<NodeID>& chain)
    {
        for (size_t i = 0; i + 1 < chain.size(); ++i)
            connect (chain[i], chain[i + 1]);
    };

    // Every serial slot, including ones passesAudio() will keep out of the
    // routing below: split positions are indices into this list, so it has to
    // stay in step with the slot vector itself.
    std::vector<const Slot*> serial;
    for (const auto& slot : slots)
        if (slot.laneId.isEmpty())
            serial.push_back (&slot);

    // The looper is a fixed node either right after the input router (loop dry
    // guitar into the rig) or right before the master output (loop the full
    // processed tone — the default).
    if (groups.empty())
    {
        std::vector<NodeID> chain { audioInputNode->nodeID, inputRouterNode->nodeID };
        if (! looperPostChain)
            chain.push_back (looperNode->nodeID);
        for (auto* slot : serial)
            if (passesAudio (slot->nodeID))
                chain.push_back (slot->nodeID);
        if (looperPostChain)
            chain.push_back (looperNode->nodeID);
        chain.push_back (metronomeNode->nodeID);
        chain.push_back (outputLevelNode->nodeID);
        chain.push_back (audioOutputNode->nodeID);
        connectChain (chain);
        return;
    }

    std::vector<NodeID> sources { inputRouterNode->nodeID };
    connect (audioInputNode->nodeID, sources.front());
    if (! looperPostChain)
    {
        connect (sources.front(), looperNode->nodeID);
        sources = { looperNode->nodeID };
    }
    int serialIndex = 0;

    // Extend the serial chain up to (but not including) serial slot `until`,
    // leaving `sources` at whatever the next split group has to fan out from.
    auto runSerialTo = [&] (int until)
    {
        for (; serialIndex < until; ++serialIndex)
        {
            const auto target = serial[(size_t) serialIndex]->nodeID;
            if (! passesAudio (target))
                continue;
            for (const auto source : sources)
                connect (source, target);
            sources = { target };
        }
    };

    for (const auto& group : groups)
    {
        runSerialTo (juce::jlimit (serialIndex, (int) serial.size(), group.position));

        std::vector<NodeID> laneOutputs;
        laneOutputs.reserve (group.lanes.size());
        for (const auto& lane : group.lanes)
        {
            std::vector<NodeID> chain;
            for (const auto& slot : slots)
                if (slot.laneId == lane.id && passesAudio (slot.nodeID))
                    chain.push_back (slot.nodeID);
            chain.push_back (lane.mixNode->nodeID);

            for (const auto source : sources)
                connect (source, chain.front());
            connectChain (chain);
            laneOutputs.push_back (lane.mixNode->nodeID);
        }
        sources = std::move (laneOutputs);
    }

    runSerialTo ((int) serial.size());
    if (looperPostChain)
    {
        for (const auto source : sources)
            connect (source, looperNode->nodeID);
        sources = { looperNode->nodeID };
    }
    for (const auto source : sources)
        connect (source, metronomeNode->nodeID);
    sources = { metronomeNode->nodeID };
    for (const auto source : sources)
        connect (source, outputLevelNode->nodeID);
    connect (outputLevelNode->nodeID, audioOutputNode->nodeID);
}
