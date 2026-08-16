#pragma once

#include <JuceHeader.h>
#include "InputRouterProcessor.h"
#include "LooperProcessor.h"
#include "MetronomeProcessor.h"

#include <vector>
#include <optional>
#include <utility>
#include <cstdint>

/**
    The heart of the guitar rig: a flexible, ordered chain of plugins wrapped
    around a juce::AudioProcessorGraph.

    Signal normally flows left -> right through the slots. Any number of
    sequential split groups may fan the signal into parallel lanes and sum
    their gain/pan-adjusted outputs before continuing through the serial chain.

    All mutating calls (add/remove/move/bypass) must happen on the message
    thread. Topology edits (add/remove/move/split) suspend audio processing
    while the graph is edited so the real-time thread never sees a half-built
    topology. Bypass is not a topology edit: bypassed slots stay wired and the
    render sequence runs their latency-compensated passthrough per block, so
    bypass changes (and therefore scene switches) are gapless. applyPluginState
    is not one either: it suspends only its own node, since restoring one
    plugin's tone must not stop the rest of the rig.
*/
class RackProcessor
{
public:
    using Node = juce::AudioProcessorGraph::Node;

    RackProcessor();
    ~RackProcessor();

    /** The underlying graph — hand this to an AudioProcessorPlayer. */
    juce::AudioProcessorGraph& getGraph() noexcept { return graph; }

    /** One entry in the rack, in signal-flow order. A slot is a generic host
        for one plugin. It holds only audio-truth: the graph node, the plugin's
        own name, bypass state, and the TS-owned `clientId` used as the shared
        key across the bridge. All user metadata (knob mappings, display name)
        lives on the TypeScript side.

        A `missing` slot has no plugin instance — its node is a plain
        passthrough placeholder, so the chain sounds as if the slot were
        bypassed. It keeps the stored plugin description and state blob
        verbatim, so capturing the rack round-trips the plugin: reinstall it,
        re-apply the rig, and the module comes back with its tone intact. */
    struct Slot
    {
        juce::AudioProcessorGraph::NodeID nodeID;
        juce::String clientId;             // opaque, TS-generated; the shared join key
        juce::String name;                 // the plugin's own name
        bool bypassed = false;
        juce::String laneId;               // empty when this slot is serial
        bool missing = false;              // placeholder for a plugin that failed to load
        juce::String missingDescription;   // preserved PluginDescription XML (missing only)
        juce::String missingState;         // preserved base64 state blob (missing only)
    };

    struct LaneState
    {
        juce::String id;
        float gain = 1.0f;
        float pan = 0.0f;
        bool muted = false;
        bool soloed = false;
    };

    struct SplitState
    {
        juce::String id;
        int position = 0;
        juce::String activeLaneId;         // empty when all lanes are summed
        std::vector<LaneState> lanes;
    };

    /** Inserts an already-created plugin instance at the given index
        (clamped), stamping it with the TS-supplied clientId. When
        `serialPosition` is supplied, split positions after that signal-path
        gap are advanced; `beforeGroupId` disambiguates consecutive splits at
        the same serial position. Takes ownership and returns the new node ID. */
    juce::AudioProcessorGraph::NodeID
        addPlugin(std::unique_ptr<juce::AudioPluginInstance> instance, int index,
                  const juce::String& clientId,
                  std::optional<int> serialPosition = std::nullopt,
                  const juce::String& beforeGroupId = {});

    /** Inserts a placeholder slot for a plugin that could not be instantiated
        (uninstalled, or failing to load). The node is a plain passthrough, so
        the slot is audibly inert — exactly like a bypassed slot — while it
        still occupies its position for moves, splits and lane membership. The
        description XML and state blob are preserved for captureRig, never
        parsed here. */
    juce::AudioProcessorGraph::NodeID
        addMissingPlugin (const juce::String& clientId, const juce::String& name,
                          const juce::String& descriptionXml, const juce::String& stateBase64,
                          int index);

    void removePlugin(juce::AudioProcessorGraph::NodeID nodeID);
    void movePlugin(int fromIndex, int toIndex);

    /** A destination for moveSlot, in the UI's pre-move coordinates. Exactly
        one of: laneId (an existing-lane gap, anchored on `beforeModuleId`),
        newLaneGroupId + newLaneId (a fresh lane of that group), or a serial
        gap (`serialPosition` counted over serial-only slots, with
        `beforeGroupId` disambiguating consecutive splits at that position). */
    struct MoveTarget
    {
        juce::String laneId;               // existing-lane gap
        juce::String beforeModuleId;       // lane anchor (clientId); empty = end of lane
        std::optional<int> serialPosition; // serial gap, pre-move coordinates
        juce::String beforeGroupId;        // land on the near side of this split
        juce::String newLaneGroupId;       // move into a new lane of this group…
        juce::String newLaneId;            // …with this TS-minted lane id
    };

    /** Atomically moves an existing slot to any signal-path gap — one suspend,
        one rebuild, one revision bump. Mirrors the TS-side arithmetic in
        ui/src/lib/engine/rackMove.ts exactly; keep the two in step. Unlike
        removePlugin, a lane emptied by the move stays — a move never collapses
        structure. */
    void moveSlot (const juce::String& clientId, const MoveTarget& target);

    /** Atomically exchanges two slots' places — each takes the other's
        position in the chain and, across a split boundary, the other's lane.
        Both keep their clientId, node and state, so everything the TS side
        keys on them follows without a fixup.

        Deliberately not two moveSlot calls: the pair of positions is fixed, so
        the flat array's lane tags read the same afterwards as before and every
        group's position — a count of the serial slots preceding it — is
        untouched. Only the two payloads change hands, never the structure they
        sit in. Mirrors swapModulesInRack() in ui/src/lib/engine/rackMove.ts —
        keep the two in step. Unknown ids, or both naming one slot, are no-ops.
        Message thread. */
    void swapSlots (const juce::String& clientIdA, const juce::String& clientIdB);

    void setBypassed(juce::AudioProcessorGraph::NodeID nodeID, bool shouldBypass);

    /** Applies several bypass changes at once (one revision bump), looked up
        by clientId. Unknown ids and no-op entries are skipped. Gapless, like
        setBypassed. Returns true if anything changed. */
    bool setBypassedBatch (const std::vector<std::pair<juce::String, bool>>& byClientId);

    /** Restores a plugin's own serialised state onto a LIVE slot, looked up by
        clientId — the per-module counterpart of the whole-rack restore in
        MainComponent::applyRigEntries, which can only ever run on a plugin
        that has not yet joined the graph. Message thread.

        Not a topology edit: only the target node is suspended for the
        duration, so the rest of the chain keeps rendering while a slow plugin
        loads, and neither the revision nor the connections change.

        A `missing` slot has no instance to write to, so the blob is stored
        into its preserved missingState instead — the tone is then not lost,
        and comes back with the plugin when it is reinstalled. Returns false
        only when no slot carries that clientId (or its instance is gone). */
    bool applyPluginState (const juce::String& clientId, const juce::MemoryBlock& state);

    /** Re-bakes the graph's render sequence (incl. per-node latency
        compensation) after a plugin reports a latency change. Message thread. */
    void refreshLatencyCompensation();

    /** Creates a split group of empty lanes at a serial position, optionally
        moving the slot at atClientId into the first lane. A non-empty
        activeLaneId (which must name one of laneIds) starts the group in switch
        mode; empty starts it summing every lane. */
    void createSplit (const juce::String& groupId, const juce::String& atClientId, int groupPosition,
                      const juce::StringArray& laneIds, const juce::String& activeLaneId = {});
    /** Adds an empty lane to an existing group. Returns false if either id is
        invalid, allowing callers to abandon an associated plugin insertion. */
    bool addLane (const juce::String& groupId, const juce::String& laneId);
    void removeLane (const juce::String& laneId);
    /** Moves a lane to another slot within its group. Lanes sum in parallel, so
        this only changes the order they are presented in. Out-of-range indices
        are clamped. */
    void moveLane (const juce::String& laneId, int toIndex);
    void movePluginToLane (const juce::String& clientId, const juce::String& laneId);
    void setLaneMix (const juce::String& laneId, std::optional<float> gain,
                     std::optional<float> pan, std::optional<bool> muted,
                     std::optional<bool> soloed);
    /** Selects the only audible lane in a split. An empty lane id restores the
        normal parallel sum. Inaudible lanes are gated by their mixer's gain
        ramp alone, so the switch fades instead of cutting; their plugins keep
        running (and keep their tails) ready for the switch back. */
    void setLaneSwitch (const juce::String& groupId, const juce::String& activeLaneId);
    void dissolveAllSplits();

    std::vector<SplitState> getSplitStates() const;
    std::uint64_t getRevision() const noexcept { return revision; }

    /** The processor behind a slot, e.g. to open its editor. May be null. */
    juce::AudioPluginInstance* getPluginInstance(juce::AudioProcessorGraph::NodeID nodeID) const;

    const std::vector<Slot>& getSlots() const noexcept { return slots; }

    /** Which of the device's enabled input channels the guitar is on.

        A guitar is one jack on an interface that has several, and picking the
        wrong one is silence with nothing on screen to explain it. The channel
        is a *connection*: the graph's input node is tapped at this pin and the
        router fans it onto both channels from there, so changing it is one edge
        moved rather than a device restart — which is what lets the setup wizard
        offer the choice against live meters instead of a checkbox list.

        Clamped at render time against the channels the device actually has, so
        a saved choice survives moving to a smaller interface. Message thread. */
    void setInputSourceChannel (int channel);
    int getInputSourceChannel() const noexcept { return inputSourceChannel; }

    void setInputGainDb (float db);
    float getInputGainDb() const noexcept;
    void setOutputGainDb (float db);
    float getOutputGainDb() const noexcept;
    /** Persisted status-bar preference. It controls analysis, but never mutes. */
    void setTunerEnabled (bool enabled);
    bool isTunerEnabled() const noexcept { return tunerEnabled; }
    /** Transient live-performance mode driven by the learned MIDI action.
        It forces analysis on and is the tuner's only output-mute reason. */
    void setMidiTunerActive (bool active);
    bool isMidiTunerActive() const noexcept { return midiTunerActive; }
    /** Silences the output while a rig is torn down and rebuilt, so the user
        never hears the half-assembled chain. Independent of the MIDI tuner mute:
        either reason alone keeps the output silent. */
    void setLoadMuted (bool muted);
    /** Silences the output while auto-standby holds the rig idle. A third
        independent reason beside the MIDI tuner and the rig load: suspension makes
        the graph clear each node's buffer, which would truncate a plugin's tail
        mid-decay as a click, and an idle amp sim's noise floor should stop too. */
    void setStandbyMuted (bool muted);
    /** Persisted safety preference: while armed, an output that stays saturated
        for longer than a chord ever does is taken to be a runaway feedback loop
        and latches the fourth, and only latching, output mute. Disarming also
        drops the latch. */
    void setFeedbackGuardEnabled (bool enabled);
    bool isFeedbackGuardEnabled() const noexcept;
    /** The latch itself. Nothing in the engine ever clears it — releasing it is
        the user saying they have turned something down. */
    void setFeedbackMuted (bool muted);
    bool isFeedbackMuted() const noexcept;
    /** The user's own mute, the fifth and last reason: the status bar's MUTE
        button and nothing else. Deliberately not the feedback latch under
        another name — disarming the guard drops that latch, and a rig the
        player muted by hand must not come back up because of it. Transient,
        like the latch: a session never starts muted. */
    void setUserMuted (bool muted);
    bool isUserMuted() const noexcept;
    /** True while any reason (MIDI tuner, rig load, standby, the feedback guard
        or the user's mute) is muting the output. */
    bool isOutputMuted() const noexcept;
    /** Global idle suspension: while set, every hosted plugin is suspended, so
        an idle rig costs no CPU. This is the only reason a plugin is ever
        suspended — a suspended node's buffer is cleared on its very next block,
        which would truncate any fade meant to carry it out, so callers must
        mute first and engage this once that ramp has landed. Implemented inside
        updateSuspendedStates() rather than as a one-shot loop over the nodes,
        so it survives every rebuildConnections() — including rebuilds triggered
        while standby is engaged. Not a topology change, so it neither suspends
        the graph nor bumps the revision. */
    void setStandbySuspended (bool shouldSuspend);
    bool isStandbySuspended() const noexcept { return standbySuspended; }
    /** Places the built-in looper after the whole chain (true, the default —
        loops carry the full processed tone) or right after the input router
        (false — loops feed dry guitar into the rig). A topology edit: suspends
        audio and rebuilds, but bumps no revision — the slot model is untouched,
        same reasoning as setStandbySuspended(). Message thread. */
    void setLooperPostChain (bool postChain);
    bool isLooperPostChain() const noexcept { return looperPostChain; }
    /** Forwards a looper action. An atomic latch, gapless — never a topology
        edit. Message thread. */
    void looperCommand (LooperProcessor::Command command);
    /** Persisted arming preferences — atomics, gapless. Message thread. */
    void setLooperArmEnabled (bool enabled);
    bool isLooperArmEnabled() const;
    void setLooperArmThresholdDb (float db);
    float getLooperArmThresholdDb() const;
    LooperProcessor::Status getLooperStatus() const;
    /** True while the looper records or plays — auto-standby must not park a
        rig whose loop is still sounding under a silent guitar. */
    bool isLooperActive() const;
    /** Message-thread copy of the loop the looper currently holds (see
        LooperProcessor::snapshotLoop for the race contract). Returns the
        length in samples, 0 when nothing is held. */
    int snapshotLooperLoop (juce::AudioBuffer<float>& dest) const;
    /** Hands a loaded loop to the looper's audio thread (see
        LooperProcessor::stageLoadedLoop for the buffer contract). */
    void stageLooperLoad (juce::AudioBuffer<float>&& buffer, int lengthSamples);
    bool isLooperLoadConsumed() const;
    /** True while the held loop is a loaded session nobody has modified —
        archiving it again would only duplicate its file. */
    bool isLooperLoopUnchangedSinceLoad() const;
    /** The rate the looper's buffers were prepared at; 0 before prepare. */
    double getLooperSampleRate() const;
    /** Built-in practice metronome controls. All setters and the command are
        atomic forwards into the fixed post-chain node, so none is a topology
        edit and all are safe to call from the message thread while audio runs. */
    void metronomeCommand (MetronomeProcessor::Command command);
    void setMetronomeEnabled (bool enabled);
    bool isMetronomeEnabled() const;
    void setMetronomeBpm (float bpm);
    float getMetronomeBpm() const;
    void setMetronomeBeatsPerBar (int beats);
    int getMetronomeBeatsPerBar() const;
    void setMetronomeSubdivision (int subdivision);
    int getMetronomeSubdivision() const;
    void setMetronomeBeatPattern (std::uint64_t pattern);
    std::uint64_t getMetronomeBeatPattern() const;
    void setMetronomeLevelDb (float db);
    float getMetronomeLevelDb() const;
    MetronomeProcessor::Status getMetronomeStatus() const;
    /** True while the click is audible, so auto-standby never parks it. */
    bool isMetronomeRunning() const;
    float consumeInputPeak() noexcept;
    /** A second, independent tap of the input level for the standby idle
        detector — consumeInputPeak() is destructive and the status meter owns it. */
    float consumeStandbyInputPeak() noexcept;
    float consumeOutputPeak() noexcept;
    TunerReading getTunerReading() const;

private:
    struct Lane
    {
        juce::String id;
        juce::AudioProcessorGraph::Node::Ptr mixNode;
        float gain = 1.0f;
        float pan = 0.0f;
        bool muted = false;
        bool soloed = false;
    };

    struct SplitGroup
    {
        juce::String id;
        int position = 0;
        juce::String activeLaneId;
        std::vector<Lane> lanes;
    };

    void rebuildConnections();
    /** True when a node has at least one audio input and one audio output, i.e.
        it can sit in the chain without breaking it. A plugin that fails this
        (an analyser with no outputs, an instrument with no inputs) is left out
        of the routing entirely rather than silencing everything after it. */
    bool passesAudio (juce::AudioProcessorGraph::NodeID nodeID) const;
    void updateLaneProcessors();
    bool laneIsAudible (const SplitGroup& group, const Lane& lane) const;
    void updateSuspendedStates();
    void updateTunerState();
    void dissolveSplit (const juce::String& groupId);
    int  indexOf(juce::AudioProcessorGraph::NodeID nodeID) const;

    juce::AudioProcessorGraph graph;
    juce::AudioProcessorGraph::Node::Ptr audioInputNode;
    juce::AudioProcessorGraph::Node::Ptr audioOutputNode;
    juce::AudioProcessorGraph::Node::Ptr inputRouterNode;
    juce::AudioProcessorGraph::Node::Ptr outputLevelNode;
    juce::AudioProcessorGraph::Node::Ptr looperNode;
    juce::AudioProcessorGraph::Node::Ptr metronomeNode;
    InputRouterProcessor* inputRouter = nullptr; // owned by inputRouterNode
    OutputLevelProcessor* outputLevel = nullptr; // owned by outputLevelNode
    LooperProcessor* looper = nullptr;           // owned by looperNode
    MetronomeProcessor* metronome = nullptr;     // owned by metronomeNode
    int inputSourceChannel = 0;      // persisted; which input pin carries the guitar
    bool looperPostChain = true;     // persisted placement preference
    bool tunerEnabled = true;        // persisted status-bar preference; never a mute request
    bool midiTunerActive = false;    // transient stage overlay; forces analysis and output mute
    bool standbySuspended = false;   // global idle override, applied in updateSuspendedStates()

    std::vector<Slot> slots;
    std::vector<SplitGroup> groups;
    std::uint64_t revision = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RackProcessor)
};
