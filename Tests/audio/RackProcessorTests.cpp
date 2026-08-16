#include <JuceHeader.h>

#include "InputRouterProcessor.h"
#include "RackProcessor.h"

#include <cmath>
#include <cstring>
#include <iostream>
#include <optional>

/*
    Headless coverage for RackProcessor's topology bookkeeping: slot order,
    connection rebuilding, and — above all — the split-group position
    arithmetic (insertions bumping positions, removals sliding them back,
    lane collapse restoring them). No audio device or message loop involved;
    all mutations run synchronously on this thread.
*/

namespace
{
    /** Minimal in-memory plugin standing in for a hosted VST3. Stereo in/out
        unless a test asks otherwise: a real VST3 declares whatever layout it
        likes (mono pedals are common), and the rack has to route it. */
    class DummyPluginInstance final : public juce::AudioPluginInstance
    {
    public:
        explicit DummyPluginInstance (juce::String name, int numIns = 2, int numOuts = 2)
            : juce::AudioPluginInstance (busesFor (numIns, numOuts)),
              pluginName (std::move (name)) {}

        void fillInPluginDescription (juce::PluginDescription& d) const override
        {
            d.name = pluginName;
            d.pluginFormatName = "Internal";
            d.uniqueId = 1;
        }

        const juce::String getName() const override            { return pluginName; }
        void prepareToPlay (double, int) override              {}
        void releaseResources() override                       {}
        void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}
        double getTailLengthSeconds() const override           { return 0.0; }
        bool acceptsMidi() const override                      { return false; }
        bool producesMidi() const override                     { return false; }
        juce::AudioProcessorEditor* createEditor() override    { return nullptr; }
        bool hasEditor() const override                        { return false; }
        int getNumPrograms() override                          { return 1; }
        int getCurrentProgram() override                       { return 0; }
        void setCurrentProgram (int) override                  {}
        const juce::String getProgramName (int) override       { return {}; }
        void changeProgramName (int, const juce::String&) override {}
        void getStateInformation (juce::MemoryBlock& out) override { out = state; }

        /** Records enough to pin applyPluginState's contract: the bytes that
            arrived, that it happened at all, and — the part a plugin doing
            file I/O here depends on — whether the node was suspended *while*
            it ran, not merely before or after. */
        void setStateInformation (const void* data, int sizeInBytes) override
        {
            state = juce::MemoryBlock (data, (size_t) sizeInBytes);
            ++setStateCalls;
            wasSuspendedDuringLoad = isSuspended();
        }

        juce::MemoryBlock state;
        int setStateCalls = 0;
        bool wasSuspendedDuringLoad = false;

    private:
        /** A zero-channel side is expressed as a missing bus, the way a plugin
            with no audio input (or no output) actually presents itself. */
        static BusesProperties busesFor (int numIns, int numOuts)
        {
            BusesProperties buses;
            if (numIns > 0)
                buses = buses.withInput ("In", juce::AudioChannelSet::canonicalChannelSet (numIns), true);
            if (numOuts > 0)
                buses = buses.withOutput ("Out", juce::AudioChannelSet::canonicalChannelSet (numOuts), true);
            return buses;
        }

        juce::String pluginName;
    };

    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    /** A plugin that exports a bypass parameter and deliberately ignores it,
        modelling the real-world VST3s whose exported bypass is dead (Uhhyou's
        OrdinaryPhaser exports one and never reads it). Doubles the signal so
        active and bypassed renders are distinguishable. Exists to guard the
        PLECTRIFY_HOST_OWNED_BYPASS JUCE patch — stock JUCE trusts the exported
        parameter and keeps calling processBlock, so this plugin never falls
        silent there. */
    class DeadBypassPluginInstance final : public juce::AudioPluginInstance
    {
    public:
        /** AudioPluginInstance parameters must be HostedParameters (addParameter
            is private there), so the bypass switch is the minimal hand-rolled one. */
        class BypassParam final : public HostedParameter
        {
        public:
            juce::String getParameterID() const override            { return "bypass"; }
            float getValue() const override                         { return value.load(); }
            void setValue (float v) override                        { value.store (v); }
            float getDefaultValue() const override                  { return 0.0f; }
            juce::String getName (int) const override               { return "bypass"; }
            juce::String getLabel() const override                  { return {}; }
            float getValueForText (const juce::String& t) const override { return t.getFloatValue(); }

        private:
            std::atomic<float> value { 0.0f };
        };

        DeadBypassPluginInstance()
            : juce::AudioPluginInstance (BusesProperties()
                  .withInput ("In", juce::AudioChannelSet::stereo(), true)
                  .withOutput ("Out", juce::AudioChannelSet::stereo(), true))
        {
            auto param = std::make_unique<BypassParam>();
            bypass = param.get();
            addHostedParameter (std::move (param));
        }

        juce::AudioProcessorParameter* getBypassParameter() const override    { return bypass; }

        void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
        {
            buffer.applyGain (2.0f);   // never consults its own bypass parameter
        }

        void fillInPluginDescription (juce::PluginDescription& d) const override
        {
            d.name = getName();
            d.pluginFormatName = "Internal";
            d.uniqueId = 2;
        }

        const juce::String getName() const override            { return "DeadBypass"; }
        void prepareToPlay (double, int) override              {}
        void releaseResources() override                       {}
        double getTailLengthSeconds() const override           { return 0.0; }
        bool acceptsMidi() const override                      { return false; }
        bool producesMidi() const override                     { return false; }
        juce::AudioProcessorEditor* createEditor() override    { return nullptr; }
        bool hasEditor() const override                        { return false; }
        int getNumPrograms() override                          { return 1; }
        int getCurrentProgram() override                       { return 0; }
        void setCurrentProgram (int) override                  {}
        const juce::String getProgramName (int) override       { return {}; }
        void changeProgramName (int, const juce::String&) override {}
        void getStateInformation (juce::MemoryBlock&) override {}
        void setStateInformation (const void*, int) override   {}

    private:
        BypassParam* bypass = nullptr;
    };

    juce::AudioProcessorGraph::NodeID addDummy (RackProcessor& rack, const juce::String& clientId,
                                                int index = 1000,
                                                std::optional<int> serialPosition = std::nullopt,
                                                const juce::String& beforeGroupId = {})
    {
        return rack.addPlugin (std::make_unique<DummyPluginInstance> (clientId), index, clientId,
                               serialPosition, beforeGroupId);
    }

    /** addDummy for the routing tests, where the plugin's channel layout is the
        thing under test. Kept separate so addDummy's tail of split-position
        arguments stays readable. */
    juce::AudioProcessorGraph::NodeID addDummyWithChannels (RackProcessor& rack, const juce::String& clientId,
                                                            int numIns, int numOuts, int index = 1000)
    {
        return rack.addPlugin (std::make_unique<DummyPluginInstance> (clientId, numIns, numOuts),
                               index, clientId, std::nullopt, {});
    }

    juce::AudioProcessorGraph::NodeID slotId (RackProcessor& rack, const juce::String& clientId)
    {
        for (const auto& slot : rack.getSlots())
            if (slot.clientId == clientId)
                return slot.nodeID;
        return {};
    }

    juce::AudioProcessorGraph::NodeID nodeNamed (RackProcessor& rack, const juce::String& name)
    {
        for (auto* node : rack.getGraph().getNodes())
            if (node->getProcessor() != nullptr && node->getProcessor()->getName() == name)
                return node->nodeID;
        return {};
    }

    /** The fixed node the user chain terminates in. The looper is the default
        post-chain terminus; testLooperPlacement() separately asserts the
        built-in looper -> metronome -> master tail. */
    juce::AudioProcessorGraph::NodeID chainTail (RackProcessor& rack)
    {
        return nodeNamed (rack, "Looper");
    }

    DummyPluginInstance* dummy (RackProcessor& rack, const juce::String& clientId)
    {
        return dynamic_cast<DummyPluginInstance*> (rack.getPluginInstance (slotId (rack, clientId)));
    }

    juce::MemoryBlock blockOf (const char* text)
    {
        return juce::MemoryBlock (text, std::strlen (text));
    }

    bool suspended (RackProcessor& rack, const juce::String& clientId)
    {
        auto* instance = rack.getPluginInstance (slotId (rack, clientId));
        return instance != nullptr && instance->isSuspended();
    }

    /** True when one specific channel of `from` feeds one specific channel of
        `to` — the resolution the non-stereo routing tests need. */
    bool connectedOn (RackProcessor& rack, juce::AudioProcessorGraph::NodeID from, int fromChannel,
                      juce::AudioProcessorGraph::NodeID to, int toChannel)
    {
        return rack.getGraph().isConnected ({ { from, fromChannel }, { to, toChannel } });
    }

    /** True when `from` feeds `to` on both stereo channels. */
    bool connected (RackProcessor& rack, juce::AudioProcessorGraph::NodeID from,
                    juce::AudioProcessorGraph::NodeID to)
    {
        return connectedOn (rack, from, 0, to, 0) && connectedOn (rack, from, 1, to, 1);
    }

    juce::String slotOrder (RackProcessor& rack)
    {
        juce::String ids;
        for (const auto& slot : rack.getSlots())
            ids += (ids.isEmpty() ? "" : ",") + slot.clientId;
        return ids;
    }

    juce::String laneOf (RackProcessor& rack, const juce::String& clientId)
    {
        for (const auto& slot : rack.getSlots())
            if (slot.clientId == clientId)
                return slot.laneId;
        return "?";
    }

    // moveSlot targets, built member-by-member (no C++20 designated inits).
    RackProcessor::MoveTarget serialTarget (int pos, const juce::String& beforeGroupId = {})
    {
        RackProcessor::MoveTarget target;
        target.serialPosition = pos;
        target.beforeGroupId = beforeGroupId;
        return target;
    }

    RackProcessor::MoveTarget laneTarget (const juce::String& laneId, const juce::String& beforeModuleId = {})
    {
        RackProcessor::MoveTarget target;
        target.laneId = laneId;
        target.beforeModuleId = beforeModuleId;
        return target;
    }

    RackProcessor::MoveTarget newLaneTarget (const juce::String& groupId, const juce::String& laneId)
    {
        RackProcessor::MoveTarget target;
        target.newLaneGroupId = groupId;
        target.newLaneId = laneId;
        return target;
    }
}

static void testEmptyRackIsPassthrough()
{
    RackProcessor rack;
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);
    expect (connected (rack, router, master), "empty rack: router feeds master directly");
}

static void testSerialChainFollowsSlotOrder()
{
    RackProcessor rack;
    const auto a = addDummy (rack, "a");
    const auto b = addDummy (rack, "b");
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);

    expect (rack.getSlots().size() == 2, "two adds produce two slots");
    expect (rack.getSlots()[0].clientId == "a" && rack.getSlots()[1].clientId == "b",
            "slot order follows add order");
    expect (connected (rack, router, a) && connected (rack, a, b) && connected (rack, b, master),
            "serial chain wires router -> a -> b -> master");

    rack.movePlugin (0, 1);
    expect (rack.getSlots()[0].clientId == "b", "movePlugin reorders slots");
    expect (connected (rack, router, b) && connected (rack, b, a) && connected (rack, a, master),
            "connections follow the reorder");

    // Bypass is per-node, not topological: the slot stays wired and the graph
    // runs its latency-compensated passthrough, so toggling is gapless.
    const auto revision = rack.getRevision();
    rack.setBypassed (a, true);
    expect (connected (rack, b, a) && connected (rack, a, master),
            "bypassed slot stays wired in the chain");
    expect (rack.getGraph().getNodeForId (a)->isBypassed(), "bypass sets the node's bypass flag");
    expect (rack.getRevision() > revision, "bypass bumps the revision");
    rack.setBypassed (a, false);
    expect (! rack.getGraph().getNodeForId (a)->isBypassed(), "un-bypass clears the node's flag");

    addDummy (rack, "c", 1);
    expect (rack.getSlots()[1].clientId == "c", "index insert lands mid-chain");

    rack.removePlugin (slotId (rack, "c"));
    expect (rack.getSlots().size() == 2, "remove shrinks the rack");
    expect (connected (rack, b, a), "chain re-links after removal");
}

static void testSplitLifecycleAndValidation()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");

    rack.createSplit ("g1", "a", 0, { "l1", "l2" });
    auto splits = rack.getSplitStates();
    expect (splits.size() == 1 && splits[0].lanes.size() == 2, "split created with two lanes");
    expect (rack.getSlots()[0].laneId == "l1", "anchor module moved into the first lane");

    rack.createSplit ("g1", "b", 0, { "l8", "l9" });
    expect (rack.getSplitStates().size() == 1, "duplicate group id is rejected");
    rack.createSplit ("g2", "b", 1, { "l1", "l5" });
    expect (rack.getSplitStates().size() == 1, "reused lane id is rejected");

    rack.movePluginToLane ("b", "l2");
    expect (slotId (rack, "b") != juce::AudioProcessorGraph::NodeID()
            && rack.getSlots()[1].laneId == "l2", "module moves into an existing lane");
    rack.movePluginToLane ("b", "missing");
    expect (rack.getSlots()[1].laneId == "l2", "unknown lane id leaves membership unchanged");

    rack.setLaneSwitch ("g1", "l1");
    expect (rack.getSplitStates()[0].activeLaneId == "l1", "lane switch selects a lane");
    rack.setLaneSwitch ("g1", "missing");
    expect (rack.getSplitStates()[0].activeLaneId == "l1", "unknown lane id leaves the switch unchanged");
    rack.setLaneSwitch ("g1", {});
    expect (rack.getSplitStates()[0].activeLaneId.isEmpty(), "empty lane id restores the parallel sum");

    auto revision = rack.getRevision();
    rack.setLaneMix ("l1", 5.0f, std::nullopt, std::nullopt, std::nullopt);
    expect (rack.getSplitStates()[0].lanes[0].gain == 2.0f, "lane gain clamps to 2");
    expect (rack.getRevision() > revision, "lane mix change bumps the revision");
    revision = rack.getRevision();
    rack.setLaneMix ("l1", 2.0f, std::nullopt, std::nullopt, std::nullopt);
    expect (rack.getRevision() == revision, "no-op lane mix keeps the revision");

    expect (rack.addLane ("g1", "l3"), "addLane on an existing group succeeds");
    expect (! rack.addLane ("g1", "l1"), "duplicate lane id is rejected by addLane");
    expect (! rack.addLane ("missing", "l7"), "unknown group is rejected by addLane");
    expect (rack.getSplitStates()[0].lanes.size() == 3, "third lane is present");
}

static void testCreateSplitCanStartInSwitchMode()
{
    // The UI splits straight into switch mode on the anchor's lane, so the
    // chain sounds unchanged the moment the split appears.
    RackProcessor rack;
    addDummy (rack, "a");
    rack.createSplit ("g1", "a", 0, { "l1", "l2" }, "l1");
    expect (rack.getSplitStates()[0].activeLaneId == "l1", "split starts switched to the requested lane");

    addDummy (rack, "b");
    rack.createSplit ("g2", "b", 1, { "l3", "l4" }, "outsider");
    const auto splits = rack.getSplitStates();
    expect (splits.size() == 2 && splits[1].activeLaneId.isEmpty(),
            "a lane id from outside the group falls back to the parallel sum");
}

static void testInsertBumpsGroupPositions()
{
    RackProcessor rack;
    addDummy (rack, "s0");
    addDummy (rack, "s1");
    rack.createSplit ("g1", "s1", 1, { "a1", "a2" });

    // Serial insert before the group: its position must advance.
    addDummy (rack, "s2", 1000, 0, {});
    expect (rack.getSplitStates()[0].position == 2,
            "group position advances past a serial insert before it");
}

static void testAdjacentGroupDisambiguation()
{
    // Two splits at the same serial position — only beforeGroupId decides
    // which side of the gap an insert lands on.
    RackProcessor rack;
    addDummy (rack, "s0");
    addDummy (rack, "x1");
    addDummy (rack, "x2");
    rack.createSplit ("g1", "x1", 1, { "a1", "a2" });
    rack.createSplit ("g2", "x2", 1, { "b1", "b2" });

    auto splits = rack.getSplitStates();
    expect (splits.size() == 2 && splits[0].position == 1 && splits[1].position == 1,
            "adjacent groups share a serial position");

    addDummy (rack, "mid", 1000, 1, "g2");
    splits = rack.getSplitStates();
    expect (splits[0].position == 1, "group before the insert gap keeps its position");
    expect (splits[1].position == 2, "group after the insert gap advances");
}

static void testInsertWithoutBeforeGroupLeavesAdjacentGroups()
{
    RackProcessor rack;
    addDummy (rack, "s0");
    addDummy (rack, "x1");
    addDummy (rack, "x2");
    rack.createSplit ("g1", "x1", 1, { "a1", "a2" });
    rack.createSplit ("g2", "x2", 1, { "b1", "b2" });

    addDummy (rack, "tail", 1000, 1, {});
    const auto splits = rack.getSplitStates();
    expect (splits[0].position == 1 && splits[1].position == 1,
            "insert without beforeGroupId leaves adjacent groups in place");
}

static void testRemovalSlidesAndCollapses()
{
    RackProcessor rack;
    addDummy (rack, "s0");
    addDummy (rack, "s1");
    addDummy (rack, "x");
    rack.createSplit ("g", "x", 2, { "l1", "l2" });

    rack.removePlugin (slotId (rack, "s0"));
    expect (rack.getSplitStates()[0].position == 1,
            "group slides forward when an earlier serial module is removed");

    // x is the last plugin in its lane and the group has only two lanes:
    // removing it collapses the whole split back into the serial chain.
    rack.removePlugin (slotId (rack, "x"));
    expect (rack.getSplitStates().empty(), "two-lane group collapses with its last plugin");
    expect (rack.getSlots().size() == 1 && rack.getSlots()[0].laneId.isEmpty(),
            "remaining module is serial again");
}

static void testThreeLaneGroupLosesOnlyEmptiedLane()
{
    RackProcessor rack;
    addDummy (rack, "a");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.addLane ("g", "l3");
    rack.setLaneSwitch ("g", "l1");

    rack.removePlugin (slotId (rack, "a")); // empties l1 of a three-lane group
    const auto splits = rack.getSplitStates();
    expect (splits.size() == 1 && splits[0].lanes.size() == 2,
            "three-lane group loses only the emptied lane");
    expect (splits[0].activeLaneId == "l2", "active lane falls back to the first remaining");
}

static void testMoveLaneReordersWithoutTouchingMembership()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.addLane ("g", "l3");
    rack.movePluginToLane ("b", "l3");
    rack.setLaneSwitch ("g", "l3");

    // Bind the snapshot to a local: ranging directly over
    // getSplitStates()[0].lanes would iterate a destroyed temporary.
    const auto laneOrder = [&rack]
    {
        const auto splits = rack.getSplitStates();
        juce::String ids;
        for (const auto& lane : splits[0].lanes)
            ids += (ids.isEmpty() ? "" : ",") + lane.id;
        return ids;
    };

    rack.moveLane ("l3", 0);
    expect (laneOrder() == "l3,l1,l2", "lane moves to the front");
    expect (rack.getSlots()[0].laneId == "l1" && rack.getSlots()[1].laneId == "l3",
            "reordering leaves module membership untouched");
    expect (rack.getSplitStates()[0].activeLaneId == "l3",
            "the switch keeps selecting the same lane after a move");

    rack.moveLane ("l3", 2);
    expect (laneOrder() == "l1,l2,l3", "lane moves to the back");

    rack.moveLane ("l1", 99);
    expect (laneOrder() == "l2,l3,l1", "an out-of-range index clamps to the last slot");

    auto revision = rack.getRevision();
    rack.moveLane ("l1", 2);
    expect (rack.getRevision() == revision, "moving a lane onto itself is a no-op");
    rack.moveLane ("missing", 0);
    expect (laneOrder() == "l2,l3,l1" && rack.getRevision() == revision,
            "an unknown lane id changes nothing");
}

static void testBypassIsHostOwned()
{
    // Guards the PLECTRIFY_HOST_OWNED_BYPASS JUCE patch: a plugin that exports
    // a bypass parameter and ignores it must still fall silent when the host
    // bypasses its node. Stock JUCE trusts the exported parameter and keeps
    // the plugin audibly running — if a JUCE bump ever drops the patch, this
    // fails rather than shipping the regression.
    RackProcessor rack;
    const auto nodeID = rack.addPlugin (std::make_unique<DeadBypassPluginInstance>(), 0,
                                        "dead", std::nullopt, {});

    auto& graph = rack.getGraph();
    graph.setPlayConfigDetails (2, 2, 48000.0, 512);
    graph.prepareToPlay (48000.0, 512);

    juce::AudioBuffer<float> buffer (2, 512);
    juce::MidiBuffer midi;
    const auto run = [&]
    {
        for (int ch = 0; ch < 2; ++ch)
            juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), 0.25f, 512);
        graph.processBlock (buffer, midi);
        return buffer.getSample (0, 100);
    };

    expect (std::abs (run() - 0.5f) < 1.0e-4f,
            "the dead-bypass plugin doubles the signal while active");

    rack.setBypassed (nodeID, true);
    expect (std::abs (run() - 0.25f) < 1.0e-4f,
            "host bypass passes through a plugin whose own bypass parameter is dead");

    rack.setBypassed (nodeID, false);
    expect (std::abs (run() - 0.5f) < 1.0e-4f, "un-bypassing resumes processing");
    graph.releaseResources();
}

static void testRemoveLaneAndDissolve()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");

    rack.removeLane ("l2");
    expect (rack.getSplitStates().empty(), "removing a lane of a two-lane split dissolves it");
    expect (rack.getSlots().size() == 1, "the removed lane takes its modules with it");
    expect (rack.getSlots()[0].clientId == "a" && rack.getSlots()[0].laneId.isEmpty(),
            "the surviving lane's module returns to the serial chain");
    expect (slotId (rack, "b") == juce::AudioProcessorGraph::NodeID(),
            "the removed module's slot is gone");

    // Three lanes: removing one keeps the split, deletes only that lane's
    // modules, and moves no later group (lane slots never counted toward a
    // group's position).
    addDummy (rack, "c");                                  // serial: a, c
    addDummy (rack, "d");                                  // serial: a, c, d
    addDummy (rack, "e");                                  // serial: a, c, d, e
    rack.createSplit ("g2", "c", 1, { "m1", "m2" });       // serial: a, d, e
    rack.addLane ("g2", "m3");
    rack.movePluginToLane ("d", "m3");                     // serial: a, e
    rack.createSplit ("g3", "e", 1, { "n1", "n2" });       // serial: a
    const auto positionBefore = rack.getSplitStates()[1].position;

    rack.removeLane ("m3");
    expect (rack.getSplitStates().size() == 2 && rack.getSplitStates()[0].lanes.size() == 2,
            "removing a lane of a three-lane split keeps the group");
    expect (slotId (rack, "d") == juce::AudioProcessorGraph::NodeID(),
            "the lane's module is removed, not restored to the serial chain");
    expect (slotId (rack, "a") != juce::AudioProcessorGraph::NodeID()
            && slotId (rack, "c") != juce::AudioProcessorGraph::NodeID(),
            "modules outside the removed lane survive");
    expect (rack.getSplitStates()[1].position == positionBefore,
            "a later group's position is untouched");

    rack.dissolveAllSplits();
    expect (rack.getSplitStates().empty(), "dissolveAllSplits clears every group");
    for (const auto& slot : rack.getSlots())
        expect (slot.laneId.isEmpty(), "no slot keeps a lane id after dissolveAllSplits");
}

static void testSplitConnectionsFanOutAndSum()
{
    RackProcessor rack;
    addDummy (rack, "pre");
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 1, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");

    const auto pre = slotId (rack, "pre");
    const auto a = slotId (rack, "a");
    const auto b = slotId (rack, "b");
    const auto master = chainTail (rack);

    expect (connected (rack, pre, a) && connected (rack, pre, b),
            "serial predecessor fans out into both lanes");
    expect (! connected (rack, a, b) && ! connected (rack, b, a),
            "parallel lanes are not chained to each other");
    // Each lane ends in its own "Lane Mix" node, which must feed the master.
    int laneMixesFeedingMaster = 0;
    for (auto* node : rack.getGraph().getNodes())
        if (node->getProcessor() != nullptr && node->getProcessor()->getName() == "Lane Mix"
            && connected (rack, node->nodeID, master))
            ++laneMixesFeedingMaster;
    expect (laneMixesFeedingMaster == 2, "both lane mixers sum into the master");
}

static void testMonoOutputFansOntoBothChannels()
{
    // The graph silently drops an edge naming a channel the plugin doesn't
    // have, so a mono-out plugin wired stereo-for-stereo would leave every
    // downstream right channel fed cleared silence.
    RackProcessor rack;
    const auto mono = addDummyWithChannels (rack, "mono", 2, 1);
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);

    expect (connectedOn (rack, router, 0, mono, 0), "stereo source feeds the mono input's left");
    expect (connectedOn (rack, mono, 0, master, 0) && connectedOn (rack, mono, 0, master, 1),
            "mono output fans onto both downstream channels");
}

static void testMonoOutputMidChainKeepsStereoDownstream()
{
    RackProcessor rack;
    addDummyWithChannels (rack, "pre", 2, 2);
    addDummyWithChannels (rack, "mono", 2, 1);
    addDummyWithChannels (rack, "post", 2, 2);

    const auto pre = slotId (rack, "pre");
    const auto mono = slotId (rack, "mono");
    const auto post = slotId (rack, "post");
    const auto master = chainTail (rack);

    expect (connectedOn (rack, pre, 0, mono, 0), "stereo predecessor feeds the mono input");
    expect (connectedOn (rack, mono, 0, post, 0) && connectedOn (rack, mono, 0, post, 1),
            "the stereo plugin after a mono one is fed on both inputs");
    expect (connected (rack, post, master), "the chain is stereo again from there on");
}

static void testMonoInputPluginIsFedAndStaysStereoOut()
{
    RackProcessor rack;
    const auto mono = addDummyWithChannels (rack, "monoIn", 1, 2);
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);

    expect (connectedOn (rack, router, 0, mono, 0), "mono input takes the left channel");
    expect (! connectedOn (rack, router, 1, mono, 0),
            "the right channel is not summed into the mono input");
    expect (connected (rack, mono, master), "a stereo output still wires channel-for-channel");
}

static void testPluginWithoutAudioOutputIsRoutedAround()
{
    // A plugin that cannot pass audio must not be allowed to break the chain:
    // it stays a slot, but the signal flows past it.
    RackProcessor rack;
    addDummyWithChannels (rack, "a", 2, 2);
    addDummyWithChannels (rack, "dead", 2, 0);
    addDummyWithChannels (rack, "b", 2, 2);

    const auto a = slotId (rack, "a");
    const auto dead = slotId (rack, "dead");
    const auto b = slotId (rack, "b");
    const auto master = chainTail (rack);

    expect (rack.getSlots().size() == 3, "the slot still exists");
    expect (connected (rack, a, b), "the chain skips straight over it");
    expect (! connectedOn (rack, a, 0, dead, 0), "nothing is wired into it");
    expect (connected (rack, b, master), "the rest of the chain is unaffected");
}

static void testMonoPluginInLaneFeedsItsMixerOnBothChannels()
{
    RackProcessor rack;
    addDummyWithChannels (rack, "a", 2, 1);
    addDummyWithChannels (rack, "b", 2, 2);
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");

    const auto a = slotId (rack, "a");

    int mixersFedOnBothChannels = 0;
    for (auto* node : rack.getGraph().getNodes())
        if (node->getProcessor() != nullptr && node->getProcessor()->getName() == "Lane Mix"
            && connectedOn (rack, a, 0, node->nodeID, 0) && connectedOn (rack, a, 0, node->nodeID, 1))
            ++mixersFedOnBothChannels;

    expect (mixersFedOnBothChannels == 1, "a mono plugin fans onto both channels of its lane mixer");
    expect (rack.getSplitStates().size() == 1, "the split survives a mono lane member");
}

static void testInactiveLanesKeepRunning()
{
    // Lane audibility is a gain gate in the lane mixer, never a suspension.
    // A suspended node has its buffer cleared on its very next block, so
    // suspending a lane the moment it turns inaudible would cut the signal
    // before the mixer's ramp could fade it out — the click the ramp exists to
    // avoid — and would leave the plugin resuming from stale state on the way
    // back. See testLaneSwitchFadesInsteadOfCutting for the signal-level proof.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");

    expect (! suspended (rack, "a") && ! suspended (rack, "b"),
            "summed lanes leave every plugin running");

    rack.setLaneSwitch ("g", "l1");
    expect (! suspended (rack, "a") && ! suspended (rack, "b"),
            "a lane switch leaves the switched-away lane's plugins running to fade");
    rack.setLaneSwitch ("g", {});
    expect (! suspended (rack, "b"), "restoring the parallel sum leaves them running");

    rack.setLaneMix ("l2", std::nullopt, std::nullopt, true, std::nullopt);
    expect (! suspended (rack, "b"), "muting a lane leaves its plugins running to fade");
    rack.setLaneMix ("l2", std::nullopt, std::nullopt, false, std::nullopt);
    expect (! suspended (rack, "b"), "unmuting leaves them running");

    rack.setLaneMix ("l1", std::nullopt, std::nullopt, std::nullopt, true);
    expect (! suspended (rack, "b") && ! suspended (rack, "a"),
            "soloing a lane leaves the un-soloed lanes running to fade");
    rack.setLaneMix ("l1", std::nullopt, std::nullopt, std::nullopt, false);
    expect (! suspended (rack, "b"), "clearing the solo leaves them running");

    rack.setLaneSwitch ("g", "l1");
    addDummy (rack, "c");
    rack.movePluginToLane ("c", "l2");
    expect (! suspended (rack, "c"), "a plugin moved into an inactive lane runs, gated by the mixer");

    // A bypassed slot must stay unsuspended: it remains wired into the chain
    // and a suspended node would emit silence instead of passing through.
    rack.setBypassed (slotId (rack, "a"), true);
    expect (! suspended (rack, "a"), "bypassing a slot leaves it running (passthrough)");
    rack.setBypassed (slotId (rack, "a"), false);
    expect (! suspended (rack, "a"), "un-bypassing keeps it running");

    rack.dissolveAllSplits();
    expect (! suspended (rack, "b") && ! suspended (rack, "c"),
            "dissolving the split leaves every plugin running");
}

static void testStandbySuspendsEveryPlugin()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    addDummy (rack, "c");

    expect (! rack.isStandbySuspended(), "a fresh rack is not in standby");
    expect (! suspended (rack, "a") && ! suspended (rack, "b") && ! suspended (rack, "c"),
            "a serial chain runs every plugin");

    rack.setStandbySuspended (true);
    expect (rack.isStandbySuspended(), "standby is reported");
    expect (suspended (rack, "a") && suspended (rack, "b") && suspended (rack, "c"),
            "standby suspends every plugin in the chain");

    rack.setStandbySuspended (false);
    expect (! suspended (rack, "a") && ! suspended (rack, "b") && ! suspended (rack, "c"),
            "leaving standby resumes every plugin");
}

static void testStandbySuspendsBypassedSlots()
{
    // The bypass exemption in updateSuspendedStates() exists only to protect
    // passthrough, and in standby the whole chain is meant to be silent — so
    // there is nothing left to pass through. Asserted separately from
    // testInactiveBranchesAreSuspended's opposite (and still correct) claim so
    // that neither can be "fixed" into the other.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.setBypassed (slotId (rack, "a"), true);
    expect (! suspended (rack, "a"), "a bypassed slot runs while awake (passthrough)");

    rack.setStandbySuspended (true);
    expect (suspended (rack, "a") && suspended (rack, "b"),
            "standby suspends bypassed slots too");

    rack.setStandbySuspended (false);
    expect (! suspended (rack, "a"), "leaving standby restores the bypassed slot's passthrough");
}

static void testStandbySurvivesRebuilds()
{
    // updateSuspendedStates() re-derives suspension from scratch at the top of
    // every rebuildConnections(), so a standby flag applied as a one-shot loop
    // over the nodes would be silently cleared by the next topology change.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.setStandbySuspended (true);

    const auto allSuspended = [&rack] (const char* what)
    {
        for (const auto& slot : rack.getSlots())
            expect (suspended (rack, slot.clientId), what);
    };

    addDummy (rack, "c");
    allSuspended ("a plugin added during standby comes up suspended");

    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    allSuspended ("creating a split leaves standby engaged");

    rack.movePluginToLane ("b", "l2");
    allSuspended ("moving a plugin into a lane leaves standby engaged");

    rack.setLaneSwitch ("g", "l1");
    allSuspended ("a lane switch leaves standby engaged");

    rack.setLaneMix ("l2", 0.5f, std::nullopt, std::nullopt, std::nullopt);
    allSuspended ("a lane mix change leaves standby engaged");

    rack.moveSlot ("c", { {}, {}, 0, {}, {}, {} });
    allSuspended ("reordering leaves standby engaged");

    rack.refreshLatencyCompensation();
    allSuspended ("a latency refresh leaves standby engaged");

    rack.removePlugin (slotId (rack, "c"));
    allSuspended ("removing a plugin leaves the rest suspended");

    rack.dissolveAllSplits();
    allSuspended ("dissolving the split leaves standby engaged");

    // And the whole rebuilt chain comes back up together on one flag flip —
    // the property a deep-standby wake depends on.
    rack.setStandbySuspended (false);
    for (const auto& slot : rack.getSlots())
        expect (! suspended (rack, slot.clientId), "one flag flip resumes the whole rebuilt chain");
}

static void testStandbyIsTheOnlySuspensionReason()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");
    rack.setLaneSwitch ("g", "l1");
    expect (! suspended (rack, "a") && ! suspended (rack, "b"),
            "the switched-away lane still runs while awake");

    rack.setStandbySuspended (true);
    expect (suspended (rack, "a") && suspended (rack, "b"),
            "standby suspends both lanes, audible or not");

    rack.setStandbySuspended (false);
    expect (! suspended (rack, "a") && ! suspended (rack, "b"),
            "leaving standby resumes both lanes; the mixer keeps gating the inaudible one");
}

static void testStandbyDoesNotBumpRevision()
{
    // The UI does not model standby, so a revision bump would push a rackChanged
    // and drag it through a full reconcile plus a session save on every nap.
    RackProcessor rack;
    addDummy (rack, "a");
    const auto revision = rack.getRevision();

    rack.setStandbySuspended (true);
    rack.setStandbySuspended (false);
    expect (rack.getRevision() == revision, "standby does not bump the rack revision");
}

static void testStandbyMuteIsIndependent()
{
    RackProcessor rack;
    expect (! rack.isOutputMuted(), "a fresh rack is not muted");

    rack.setStandbyMuted (true);
    expect (rack.isOutputMuted(), "the standby mute alone mutes");

    rack.setLoadMuted (true);
    rack.setStandbyMuted (false);
    expect (rack.isOutputMuted(), "clearing the standby mute does not clear the load mute");

    rack.setStandbyMuted (true);
    rack.setLoadMuted (false);
    expect (rack.isOutputMuted(), "clearing the load mute does not clear the standby mute");

    rack.setMidiTunerActive (true);
    rack.setStandbyMuted (false);
    expect (rack.isOutputMuted(), "clearing the standby mute does not clear the MIDI tuner mute");

    rack.setMidiTunerActive (false);
    expect (! rack.isOutputMuted(), "clearing every reason restores the output");
}

static void testStandbyMuteFades()
{
    // The standby mute must share the ramp, not hard-clear: entering standby
    // while the amp is still ringing would otherwise click.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, 64);

    juce::AudioBuffer<float> buffer (2, 64);
    juce::MidiBuffer midi;
    const auto runBlock = [&]
    {
        for (int ch = 0; ch < 2; ++ch)
            juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), 1.0f, 64);
        output.processBlock (buffer, midi);
    };

    runBlock();
    expect (buffer.getSample (0, 63) > 0.99f, "an unmuted output passes full scale");

    output.setStandbyMute (true);
    runBlock();
    expect (buffer.getSample (0, 0) > 0.9f && buffer.getSample (0, 63) < 0.95f,
            "the first standby-muted block ramps down instead of clearing");

    int blocks = 0;
    while (buffer.getMagnitude (0, 0, 64) > 0.0f && blocks++ < 100)
        runBlock();
    expect (blocks < 20, "the standby fade reaches silence within a few milliseconds");

    output.setStandbyMute (false);
    runBlock();
    expect (buffer.getSample (0, 63) > buffer.getSample (0, 0),
            "waking ramps back up rather than jumping");
}

// --- Feedback guard --------------------------------------------------------
// The signature is a level that will not fall, so these helpers are written in
// terms of *envelope shape* rather than loudness. At 48 kHz in 64-sample blocks
// there are 750 blocks to the second: 225 for the 0.3 s saturated dwell, 750
// for the 1 s non-decaying dwell.
namespace
{
    constexpr int guardBlockSize = 64;
    constexpr int guardBlocksPerSecond = 750;
    constexpr int guardSteadyBlocks = 750;
    constexpr int guardSaturatedBlocks = 225;
    // The level the reported squeal sat at: -8 dBFS peak, and since it is close
    // to a sine, about -11 dBFS RMS. Well under the saturated fast path, which
    // is exactly why the first version of this guard never fired.
    constexpr float guardSquealLevel = 0.28f;

    /** `blocks` blocks of an unchanging level — the shape feedback has. */
    void runLevel (OutputLevelProcessor& output, float level, int blocks)
    {
        juce::AudioBuffer<float> buffer (2, guardBlockSize);
        juce::MidiBuffer midi;
        for (int block = 0; block < blocks; ++block)
        {
            for (int ch = 0; ch < 2; ++ch)
                juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), level, guardBlockSize);
            output.processBlock (buffer, midi);
        }
    }

    /** Plucked notes: each decays from `peakLevel` to a twentieth of it (-26 dB)
        across `blocksPerNote`, then the next one starts. The shape every real
        guitar makes and the one the guard must never mute. */
    void runPlucking (OutputLevelProcessor& output, float peakLevel, int blocksPerNote, int notes)
    {
        juce::AudioBuffer<float> buffer (2, guardBlockSize);
        juce::MidiBuffer midi;
        for (int note = 0; note < notes; ++note)
        {
            for (int block = 0; block < blocksPerNote; ++block)
            {
                const auto decay = std::pow (0.05f, (float) block / (float) blocksPerNote);
                for (int ch = 0; ch < 2; ++ch)
                    juce::FloatVectorOperations::fill (
                        buffer.getWritePointer (ch), peakLevel * decay, guardBlockSize);
                output.processBlock (buffer, midi);
            }
        }
    }
}

static void testFeedbackGuardTripsOnASteadySqueal()
{
    // The bug this exists for: a high-pitched squeal at -8 dBFS peak never
    // reaches the saturated fast path, and the guard sat there doing nothing.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    expect (! output.isFeedbackGuardEnabled(), "the guard is disarmed by default");
    output.setFeedbackGuardEnabled (true);

    runLevel (output, guardSquealLevel, guardSteadyBlocks - 40);
    expect (! output.isFeedbackTripped(), "a steady tone short of the dwell has not tripped");

    runLevel (output, guardSquealLevel, 80);
    expect (output.isFeedbackTripped(), "a squeal that holds its level past the dwell trips");
    expect (output.isMuted(), "tripping mutes the output");
}

static void testFeedbackGuardCountsWhileASquealIsStillBuilding()
{
    // Rising is free, and this is why: a loop that takes half a second to build
    // must not then be charged the whole dwell on top. A rule that waited for a
    // plateau would mute at 1.5 s here; this one mutes at 1.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);

    const int rampBlocks = guardBlocksPerSecond / 2;
    for (int block = 0; block < rampBlocks; ++block)
        runLevel (output, 0.12f + 0.3f * ((float) block / (float) rampBlocks), 1);
    runLevel (output, 0.42f, guardSteadyBlocks - rampBlocks + 20);
    expect (output.isFeedbackTripped(), "the build counts towards the dwell, not against it");
}

static void testFeedbackGuardTripsFastOnSaturation()
{
    // A loop that has already driven the chain into saturation must not even
    // cost the room the one-second dwell.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);

    runLevel (output, 1.0f, guardSaturatedBlocks + 20);
    expect (output.isFeedbackTripped(), "saturation trips on the fast path");
}

static void testFeedbackGuardIgnoresPlaying()
{
    // Ten seconds of notes, each decaying over about a third of a second, at a
    // level well above the guard's floor. If this trips, the guard is unusable.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);

    runPlucking (output, 0.6f, guardBlocksPerSecond / 3, 30);
    expect (! output.isFeedbackTripped(), "decaying notes never trip, however long you play");
}

static void testFeedbackGuardIgnoresSteadyHiss()
{
    // A high-gain amp sim's idle noise is perfectly steady and lasts forever.
    // Only the floor keeps it from being read as feedback.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);

    runLevel (output, 0.02f, guardSteadyBlocks * 2);
    expect (! output.isFeedbackTripped(), "hiss below the floor is not feedback");

    runLevel (output, 0.0f, guardSteadyBlocks * 2);
    expect (! output.isFeedbackTripped(), "and neither is silence");
}

static void testFeedbackGuardIgnoresADynamicLevel()
{
    // Ten seconds of loud playing that never drops below the floor but swings
    // 12 dB between phrases. Every drop ends a run, so no run reaches a second.
    // The swings are deliberately shorter than the dwell: a level held flat for
    // a full second *is* the signature, whatever it is.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);

    for (int phrase = 0; phrase < 25; ++phrase)
        runLevel (output, phrase % 2 == 0 ? 0.15f : 0.6f, guardBlocksPerSecond * 2 / 5);
    expect (! output.isFeedbackTripped(), "a level that keeps dropping never completes a dwell");
}

static void testFeedbackGuardOffNeverTrips()
{
    OutputLevelProcessor output;
    output.setFeedbackGuardEnabled (false);
    output.prepareToPlay (48000.0, guardBlockSize);

    runLevel (output, 1.0f, guardSteadyBlocks * 2);
    expect (! output.isFeedbackTripped(), "a disarmed guard never trips");
    expect (! output.isMuted(), "and never mutes");
}

static void testClearingTheFeedbackLatchDoesNotInstantlyRetrip()
{
    // The regression this exists for: the user clicks unmute, and the rig goes
    // silent again a block later because the dwell resumed where it stopped.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);
    runLevel (output, guardSquealLevel, guardSteadyBlocks + 20);
    expect (output.isFeedbackTripped(), "tripped, ready to clear");

    output.setFeedbackTripped (false);
    runLevel (output, guardSquealLevel, 1);
    expect (! output.isFeedbackTripped(), "clearing the latch survives the next block");
    expect (! output.isMuted(), "the output is audible again");

    runLevel (output, guardSquealLevel, guardSteadyBlocks - 60);
    expect (! output.isFeedbackTripped(), "the dwell starts over from the clear");
    runLevel (output, guardSquealLevel, 120);
    expect (output.isFeedbackTripped(), "and trips again if the loop really is still running");
}

static void testDisarmingTheGuardDropsTheLatch()
{
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);
    runLevel (output, guardSquealLevel, guardSteadyBlocks + 20);
    expect (output.isMuted(), "tripped and muted");

    output.setFeedbackGuardEnabled (false);
    expect (! output.isFeedbackTripped() && ! output.isMuted(),
            "turning the guard off also releases the mute it is holding");
}

static void testFeedbackGuardIgnoresBlocksTheOtherMutesOwn()
{
    // A rig load hands this node whatever the half-built chain produced. Muting
    // the user cannot explain is worse than no guard at all.
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, guardBlockSize);
    output.setFeedbackGuardEnabled (true);
    output.setLoadMute (true);

    runLevel (output, 1.0f, guardSteadyBlocks * 2);
    expect (! output.isFeedbackTripped(), "a load-muted block is not evidence of feedback");

    output.setLoadMute (false);
    expect (! output.isMuted(), "and the load mute lifts cleanly");
}

static void testFeedbackMuteIsIndependent()
{
    RackProcessor rack;
    expect (! rack.isFeedbackGuardEnabled(), "a fresh rack leaves the guard disarmed");
    expect (! rack.isOutputMuted(), "and is not muted");
    rack.setFeedbackGuardEnabled (true);

    rack.setFeedbackMuted (true);
    expect (rack.isOutputMuted(), "the feedback latch alone mutes");

    rack.setStandbyMuted (true);
    rack.setFeedbackMuted (false);
    expect (rack.isOutputMuted(), "clearing the feedback latch does not clear the standby mute");

    rack.setFeedbackMuted (true);
    rack.setStandbyMuted (false);
    expect (rack.isOutputMuted(), "clearing the standby mute does not clear the feedback latch");

    rack.setFeedbackGuardEnabled (false);
    expect (! rack.isOutputMuted(), "disarming the guard releases its latch and nothing else");
}

static void testStandbyMeterIsIndependentOfTheStatusMeter()
{
    // consumeInputPeak() is a destructive exchange(0) owned by the status bar's
    // meter. If the idle detector shared it, whichever consumer polled first
    // would starve the other of every block it read.
    InputRouterProcessor input;
    juce::AudioBuffer<float> buffer (2, 64);
    juce::MidiBuffer midi;
    for (int ch = 0; ch < 2; ++ch)
        juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), 0.5f, 64);
    input.processBlock (buffer, midi);

    expect (input.consumePeak() > 0.49f, "the status meter sees the block");
    expect (input.consumeStandbyPeak() > 0.49f, "the standby meter sees the same block");
    expect (input.consumePeak() == 0.0f, "consuming the status meter resets it");
    expect (input.consumeStandbyPeak() == 0.0f, "consuming the standby meter resets it");
}

static void testBypassBatch()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "b", 1, { "l1", "l2" });

    auto revision = rack.getRevision();
    expect (rack.setBypassedBatch ({ { "a", true }, { "b", true }, { "missing", true } }),
            "batch reports a change");
    expect (rack.getSlots()[0].bypassed && rack.getSlots()[1].bypassed,
            "batch sets every matched slot, serial and laned alike");
    expect (rack.getGraph().getNodeForId (slotId (rack, "a"))->isBypassed()
                && rack.getGraph().getNodeForId (slotId (rack, "b"))->isBypassed(),
            "batch drives the node bypass flags");
    expect (rack.getRevision() == revision + 1, "batch bumps the revision exactly once");

    revision = rack.getRevision();
    expect (! rack.setBypassedBatch ({ { "a", true }, { "missing", false } }),
            "all-no-op batch reports no change");
    expect (rack.getRevision() == revision, "no-op batch keeps the revision");

    expect (rack.setBypassedBatch ({ { "a", false }, { "b", false } }), "batch un-bypasses");
    expect (! rack.getSlots()[0].bypassed && ! rack.getSlots()[1].bypassed,
            "flags cleared by the second batch");
}

static void testApplyPluginState()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    const auto revision = rack.getRevision();
    const auto master = chainTail (rack);

    expect (rack.applyPluginState ("a", blockOf ("tone-bytes")), "applying to a live slot reports success");

    auto* target = dummy (rack, "a");
    juce::MemoryBlock roundTrip;
    target->getStateInformation (roundTrip);
    expect (roundTrip == blockOf ("tone-bytes"), "the plugin receives the exact bytes");
    expect (target->wasSuspendedDuringLoad, "the target is suspended while its state loads");
    expect (! target->isSuspended(), "and is running again afterwards");

    // The whole point of suspending per node rather than per graph: a slow
    // load must not stop the rest of the rig.
    auto* other = dummy (rack, "b");
    expect (other->setStateCalls == 0 && ! other->isSuspended(),
            "no other plugin is touched or suspended");

    expect (rack.getRevision() == revision && connected (rack, slotId (rack, "a"), slotId (rack, "b"))
                && connected (rack, slotId (rack, "b"), master),
            "restoring state is not a topology edit");

    expect (! rack.applyPluginState ("nobody", blockOf ("x")), "an unknown clientId reports failure");
    expect (dummy (rack, "a")->setStateCalls == 1, "and writes to nothing");
}

static void testApplyPluginStateHonoursStandby()
{
    RackProcessor rack;
    addDummy (rack, "a");
    rack.setStandbySuspended (true);

    expect (rack.applyPluginState ("a", blockOf ("parked")), "state applies while parked");
    expect (suspended (rack, "a"),
            "standby survives the load — the restore goes through updateSuspendedStates()");
}

static void testApplyPluginStateOnMissingSlot()
{
    RackProcessor rack;
    rack.addMissingPlugin ("m", "Gone Amp", "<desc/>", "c3RhdGU=", 0);

    expect (rack.applyPluginState ("m", blockOf ("later")), "a placeholder accepts state");
    expect (rack.getSlots()[0].missingState == juce::Base64::toBase64 ("later", 5),
            "the blob is preserved base64'd, ready for the day the plugin returns");
}

static void testMidiTunerStateAndMuteReasons()
{
    RackProcessor rack;
    expect (! rack.isOutputMuted(), "a fresh rack is not muted");
    expect (rack.isTunerEnabled(), "the manual tuner defaults on");
    expect (! rack.isMidiTunerActive(), "the transient MIDI tuner defaults off");

    rack.setTunerEnabled (false);
    expect (! rack.isOutputMuted(), "turning the manual tuner off does not mute");
    rack.setMidiTunerActive (true);
    expect (rack.isOutputMuted(), "the MIDI live tuner always mutes");
    expect (! rack.isTunerEnabled(), "MIDI tuning does not overwrite the manual preference");

    rack.setTunerEnabled (true);
    rack.setMidiTunerActive (false);
    expect (! rack.isOutputMuted(), "leaving MIDI tuning restores audible manual tuning");
    expect (rack.isTunerEnabled(), "the manual preference survives a MIDI tuning cycle");

    rack.setLoadMuted (true);
    rack.setMidiTunerActive (true);
    rack.setMidiTunerActive (false);
    expect (rack.isOutputMuted(), "leaving MIDI tuning does not clear the load mute");

    rack.setLoadMuted (false);
    expect (! rack.isOutputMuted(), "clearing the load mute restores the output");

    rack.setLoadMuted (true);
    rack.setMidiTunerActive (true);
    rack.setLoadMuted (false);
    expect (rack.isOutputMuted(), "clearing the load mute does not clear the MIDI tuner mute");
}

static void testOutputMuteFadesInsteadOfClicking()
{
    OutputLevelProcessor output;
    output.prepareToPlay (48000.0, 64);

    juce::AudioBuffer<float> buffer (2, 64);
    juce::MidiBuffer midi;
    const auto runBlock = [&]
    {
        for (int ch = 0; ch < 2; ++ch)
            juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), 1.0f, 64);
        output.processBlock (buffer, midi);
    };

    runBlock();
    expect (buffer.getSample (0, 63) > 0.99f, "an unmuted output passes full scale");

    output.setLoadMute (true);
    runBlock();
    expect (buffer.getSample (0, 0) > 0.9f && buffer.getSample (0, 63) < 0.95f,
            "the first muted block ramps down instead of clearing");

    int blocks = 0;
    while (buffer.getMagnitude (0, 0, 64) > 0.0f && blocks++ < 100)
        runBlock();
    expect (blocks < 20, "the fade reaches silence within a few milliseconds");

    runBlock();
    expect (buffer.getMagnitude (0, 0, 64) == 0.0f, "a fully muted output is exactly silent");

    output.setLoadMute (false);
    runBlock();
    expect (buffer.getSample (0, 0) < 0.2f && buffer.getSample (0, 63) > buffer.getSample (0, 0),
            "un-muting ramps back up rather than jumping");
}

static void testLaneSwitchFadesInsteadOfCutting()
{
    // The one case the topology tests cannot see: switching away must let the
    // lane mixer's ramp carry the old lane out. Suspending its plugins in the
    // same message-thread turn would clear their buffer on the very next block,
    // so the mixer would ramp over silence and the lane would cut dead — the
    // click the ramp exists to avoid, taking any effect tail with it. Rendered
    // through the real graph, since that truncation only shows in the signal.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g", "a", 0, { "l1", "l2" });
    rack.movePluginToLane ("b", "l2");
    // Mute l1 so the block carries l2's contribution alone; an unmuted l1 would
    // ramp up as l2 ramps down and the crossfade would hide the cut.
    rack.setLaneMix ("l1", std::nullopt, std::nullopt, true, std::nullopt);
    rack.setLaneSwitch ("g", "l2");

    auto& graph = rack.getGraph();
    graph.setPlayConfigDetails (2, 2, 48000.0, 64);
    graph.prepareToPlay (48000.0, 64);

    juce::AudioBuffer<float> buffer (2, 64);
    juce::MidiBuffer midi;
    const auto runBlock = [&]
    {
        for (int ch = 0; ch < 2; ++ch)
            juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), 1.0f, 64);
        graph.processBlock (buffer, midi);
    };

    runBlock();
    expect (buffer.getMagnitude (0, 0, 64) > 0.5f, "the switched-on lane passes signal");

    rack.setLaneSwitch ("g", "l1");
    runBlock();
    expect (buffer.getSample (0, 0) > 0.5f,
            "the block after a switch starts at the old lane's level, not cleared");
    expect (buffer.getSample (0, 63) < 0.05f, "and ramps down to silence across it");

    runBlock();
    expect (buffer.getMagnitude (0, 0, 64) < 0.01f, "the switched-away lane is silent thereafter");
}

static void testMoveSlotWithinSegment()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    addDummy (rack, "c");

    // Targets are in pre-move coordinates: the gap after c is serial gap 3
    // even though detaching a shifts it to 2 internally.
    rack.moveSlot ("a", serialTarget (3));
    expect (slotOrder (rack) == "b,c,a", "moveSlot lands on the pre-move gap");

    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);
    expect (connected (rack, router, slotId (rack, "b"))
                && connected (rack, slotId (rack, "b"), slotId (rack, "c"))
                && connected (rack, slotId (rack, "c"), slotId (rack, "a"))
                && connected (rack, slotId (rack, "a"), master),
            "connections follow the move");
}

static void testMoveSlotAcrossSplitBoundary()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "x");
    addDummy (rack, "b");
    rack.createSplit ("g1", "x", 1, { "l1", "l2" }); // serial [a, b], split between them

    // b jumps to the head of the chain: the split gains a preceding module.
    rack.moveSlot ("b", serialTarget (0));
    expect (slotOrder (rack) == "b,a,x", "serial module crosses the split backwards");
    expect (rack.getSplitStates()[0].position == 2,
            "group position advances when a serial module moves before it");

    // …and back past the split again (pre-move gap after a, no beforeGroupId
    // ⇒ the far side of the split).
    rack.moveSlot ("b", serialTarget (2));
    expect (slotOrder (rack) == "a,x,b", "serial module crosses the split forwards");
    expect (rack.getSplitStates()[0].position == 1,
            "group position slides back when the module leaves its near side");
}

static void testMoveSlotIntoAndOutOfLane()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "x");
    addDummy (rack, "b");
    rack.createSplit ("g1", "x", 1, { "l1", "l2" });

    // Serial → lane: the chain loses a preceding module, so the group slides.
    rack.moveSlot ("a", laneTarget ("l2"));
    expect (laneOf (rack, "a") == "l2", "serial module joins the lane");
    expect (rack.getSplitStates()[0].position == 0,
            "group position drops when a preceding serial module becomes laned");
    const auto router = nodeNamed (rack, "Guitar Input Router");
    expect (connected (rack, router, slotId (rack, "x")) && connected (rack, router, slotId (rack, "a")),
            "the input now fans straight into both lanes");

    // Lane → serial, landing on the near side of the split it came from.
    rack.moveSlot ("a", serialTarget (0, "g1"));
    expect (laneOf (rack, "a").isEmpty(), "lane module rejoins the serial chain");
    expect (rack.getSplitStates()[0].position == 1,
            "group position advances past the re-entered module");
    expect (connected (rack, router, slotId (rack, "a")) && connected (rack, slotId (rack, "a"), slotId (rack, "x")),
            "the chain runs input -> a -> split again");

    // Lane-internal ordering via the anchor.
    rack.moveSlot ("a", laneTarget ("l1", "x"));
    expect (laneOf (rack, "a") == "l1", "anchored move joins the anchor's lane");
    expect (slotOrder (rack) == "a,x,b", "anchored move lands before the anchor");
}

static void testSwapSlotsTradesPlacesAndRewires()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    addDummy (rack, "c");

    rack.swapSlots ("a", "c");
    expect (slotOrder (rack) == "c,b,a", "swapped slots trade places in the chain");

    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);
    expect (connected (rack, router, slotId (rack, "c"))
                && connected (rack, slotId (rack, "c"), slotId (rack, "b"))
                && connected (rack, slotId (rack, "b"), slotId (rack, "a"))
                && connected (rack, slotId (rack, "a"), master),
            "connections follow the swap");

    // Adjacent slots are the case a naive detach-and-reinsert gets wrong.
    rack.swapSlots ("b", "a");
    expect (slotOrder (rack) == "c,a,b", "adjacent slots swap cleanly");
}

static void testSwapSlotsCrossesLaneBoundariesWithoutMovingSplits()
{
    // serial [a, b] with a split between them; x sits in lane l1.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "x");
    addDummy (rack, "b");
    rack.createSplit ("g1", "x", 1, { "l1", "l2" });
    expect (rack.getSplitStates()[0].position == 1, "precondition: the split follows one module");

    // The *places* keep their lane membership, so a trades into the lane and x
    // into the serial chain — and, unlike a pair of moves, nothing about the
    // split's position has to be fixed up in between.
    rack.swapSlots ("a", "x");
    expect (laneOf (rack, "a") == "l1" && laneOf (rack, "x").isEmpty(),
            "each module takes the other's lane membership");
    expect (slotOrder (rack) == "x,a,b", "flat order is unchanged but for the two payloads");
    expect (rack.getSplitStates()[0].position == 1, "the split does not move");

    const auto router = nodeNamed (rack, "Guitar Input Router");
    expect (connected (rack, router, slotId (rack, "x")), "the serial head is now x");

    // Lane ↔ lane, across two lanes of the same group.
    rack.movePluginToLane ("b", "l2");
    rack.swapSlots ("a", "b");
    expect (laneOf (rack, "a") == "l2" && laneOf (rack, "b") == "l1",
            "modules trade lanes within a split");
    expect (rack.getSplitStates()[0].lanes.size() == 2, "no lane is emptied or born by a swap");
}

static void testSwapSlotsNoOps()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");

    const auto revision = rack.getRevision();
    rack.swapSlots ("a", "a");
    rack.swapSlots ("a", "gone");
    rack.swapSlots ("gone", "b");
    expect (slotOrder (rack) == "a,b" && rack.getRevision() == revision,
            "a self-swap or an unknown id leaves the rack and revision alone");
}

static void testMoveSlotAdjacentGroups()
{
    // Two splits at one serial position: beforeGroupId decides which side of
    // the shared gap a moved module lands on — here, between the two splits.
    RackProcessor rack;
    addDummy (rack, "s0");
    addDummy (rack, "x1");
    addDummy (rack, "x2");
    rack.createSplit ("g1", "x1", 1, { "a1", "a2" });
    rack.createSplit ("g2", "x2", 1, { "b1", "b2" });

    rack.moveSlot ("s0", serialTarget (1, "g2"));
    const auto splits = rack.getSplitStates();
    expect (splits[0].position == 0 && splits[1].position == 1,
            "the moved module lands between the two co-located splits");
}

static void testMoveSlotEmptiedLaneStays()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "x");
    addDummy (rack, "b");
    rack.createSplit ("g1", "x", 1, { "l1", "l2" });

    // x was l1's only plugin. Unlike removePlugin, moving it out must leave
    // the lane (and the whole split) in place — a move never collapses
    // structure.
    rack.moveSlot ("x", serialTarget (0));
    expect (laneOf (rack, "x").isEmpty(), "the moved module is serial again");
    const auto splits = rack.getSplitStates();
    expect (splits.size() == 1 && splits[0].lanes.size() == 2,
            "the emptied lane stays and the split survives");
    expect (splits[0].position == 2, "the split keeps its place in the chain");
}

static void testMoveSlotIntoNewLane()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g1", "a", 0, { "l1", "l2" });

    const auto revision = rack.getRevision();
    rack.moveSlot ("b", newLaneTarget ("g1", "l3"));
    expect (rack.getSplitStates()[0].lanes.size() == 3, "the fresh lane exists");
    expect (laneOf (rack, "b") == "l3", "the module lives in the fresh lane");
    expect (rack.getRevision() == revision + 1,
            "lane birth and move are one atomic edit (one revision bump)");

    // Invalid new-lane targets change nothing and leak no lane.
    rack.moveSlot ("b", newLaneTarget ("g1", "l1"));
    expect (rack.getSplitStates()[0].lanes.size() == 3 && laneOf (rack, "b") == "l3",
            "a duplicate lane id is rejected");
    rack.moveSlot ("b", newLaneTarget ("missing", "l9"));
    expect (rack.getSplitStates()[0].lanes.size() == 3 && laneOf (rack, "b") == "l3",
            "an unknown group is rejected");
    expect (rack.getRevision() == revision + 1, "rejected moves keep the revision");
}

static void testMoveSlotNoOps()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    addDummy (rack, "c");
    rack.createSplit ("g1", "c", 2, { "l1", "l2" });

    // Both gaps flanking b resolve to its own spot even though b's serial
    // successor gap is not flat-adjacent (c sits after b in the flat array) —
    // the flat-index trap that once corrupted g1's position. The after-gap
    // names the co-located split it stops short of. An untouched revision
    // proves no suspend/rebuild happened.
    const auto revision = rack.getRevision();
    rack.moveSlot ("b", serialTarget (1));
    rack.moveSlot ("b", serialTarget (2, "g1"));
    expect (slotOrder (rack) == "a,b,c" && rack.getRevision() == revision,
            "a serial module dropped on its own gaps is a no-op");

    rack.moveSlot ("c", laneTarget ("l1"));
    expect (rack.getRevision() == revision,
            "the last lane module dropped on its end-of-lane gap is a no-op");
    rack.moveSlot ("c", laneTarget ("l1", "c"));
    expect (rack.getRevision() == revision, "dropping before yourself is a no-op");

    rack.moveSlot ("missing", serialTarget (0));
    rack.moveSlot ("a", laneTarget ("missing"));
    expect (slotOrder (rack) == "a,b,c" && rack.getRevision() == revision,
            "unknown module or lane ids change nothing");

    // The same gap index WITHOUT beforeGroupId is the split's far side — a
    // real move, not a no-op.
    rack.moveSlot ("b", serialTarget (2));
    expect (rack.getRevision() > revision && rack.getSplitStates()[0].position == 1,
            "the after-split gap at the same index is a real move");
}

static void testMoveSlotAcrossAdjacentSplit()
{
    // m sits directly after the split. Dropping it on the before-split gap
    // changes only the group position — the flat order stays identical, which
    // an index-based no-op test would misread and swallow.
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "x");
    addDummy (rack, "m");
    rack.createSplit ("g1", "x", 1, { "l1", "l2" });

    const auto revision = rack.getRevision();
    rack.moveSlot ("m", serialTarget (1, "g1"));
    expect (rack.getRevision() > revision, "the same-flat-index move is not swallowed");
    expect (slotOrder (rack) == "a,x,m" && rack.getSplitStates()[0].position == 2,
            "the module crosses to the split's near side (flat order unchanged)");

    rack.moveSlot ("m", serialTarget (2));
    expect (rack.getSplitStates()[0].position == 1, "the plain after-split gap moves it back");
}

static void testMoveSlotLaneNoOpWithInterleavedFlatOrder()
{
    // l1 = [x, y] with serial s between them in the flat array: an
    // index-based no-op test would misresolve x's before-successor gap and
    // commit a flat-order shuffle.
    RackProcessor rack;
    addDummy (rack, "x");
    addDummy (rack, "s");
    addDummy (rack, "y");
    rack.createSplit ("g1", "x", 0, { "l1", "l2" });
    rack.moveSlot ("y", laneTarget ("l1")); // real move: y joins the end of l1
    expect (slotOrder (rack) == "x,s,y" && laneOf (rack, "y") == "l1",
            "setup: the lane interleaves with the serial chain");

    const auto revision = rack.getRevision();
    rack.moveSlot ("x", laneTarget ("l1", "y"));
    expect (slotOrder (rack) == "x,s,y" && rack.getRevision() == revision,
            "a lane module dropped before its own successor is a no-op");
}

static void testMoveSlotIntoSwitchedOffLane()
{
    RackProcessor rack;
    addDummy (rack, "a");
    addDummy (rack, "b");
    rack.createSplit ("g1", "a", 0, { "l1", "l2" });
    rack.setLaneSwitch ("g1", "l1");

    rack.moveSlot ("b", laneTarget ("l2"));
    expect (laneOf (rack, "b") == "l2" && ! suspended (rack, "b"),
            "moving into the switched-away lane lands there with the plugin still running");

    rack.moveSlot ("b", serialTarget (1));
    expect (laneOf (rack, "b").isEmpty() && ! suspended (rack, "b"),
            "moving back out returns it to the serial chain");
}

static void testMissingSlotIsWiredLikeAnyOther()
{
    RackProcessor rack;
    const auto a = addDummy (rack, "a");
    const auto missing = rack.addMissingPlugin ("m", "Gone Amp", "<desc/>", "c3RhdGU=", 1);
    const auto b = addDummy (rack, "b");
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto master = chainTail (rack);

    expect (slotOrder (rack) == "a,m,b", "missing slot occupies its rack position");
    const auto& slot = rack.getSlots()[1];
    expect (slot.missing, "slot is flagged missing");
    expect (slot.name == "Gone Amp", "slot keeps the plugin's name");
    expect (slot.missingDescription == "<desc/>" && slot.missingState == "c3RhdGU=",
            "description/state are preserved verbatim");
    expect (rack.getPluginInstance (missing) == nullptr, "a missing slot has no plugin instance");
    expect (connected (rack, router, a) && connected (rack, a, missing)
                && connected (rack, missing, b) && connected (rack, b, master),
            "missing slot is wired through like any other");

    // Everything a slot supports still works on the placeholder.
    rack.setBypassed (missing, true);
    expect (rack.getSlots()[1].bypassed, "missing slot can be bypassed");
    rack.movePlugin (1, 2);
    expect (slotOrder (rack) == "a,b,m", "missing slot moves like any other");
    rack.removePlugin (missing);
    expect (slotOrder (rack) == "a,b" && connected (rack, b, master),
            "chain re-links after removing the placeholder");
}

static void testLooperPlacement()
{
    RackProcessor rack;
    const auto a = addDummy (rack, "a");
    const auto b = addDummy (rack, "b");
    const auto router = nodeNamed (rack, "Guitar Input Router");
    const auto looperNode = nodeNamed (rack, "Looper");
    const auto metronomeNode = nodeNamed (rack, "Metronome");
    const auto master = nodeNamed (rack, "Master Output");

    expect (rack.isLooperPostChain(), "looper defaults to post-chain");
    expect (connected (rack, b, looperNode) && connected (rack, looperNode, metronomeNode)
                && connected (rack, metronomeNode, master),
            "post-chain: last slot feeds looper, metronome, then master");
    expect (! connected (rack, router, looperNode), "post-chain: looper is not at the input");

    const auto revision = rack.getRevision();
    rack.setLooperPostChain (false);
    expect (rack.getRevision() == revision, "placement change bumps no revision");
    expect (connected (rack, router, looperNode) && connected (rack, looperNode, a),
            "pre-chain: router feeds the looper, looper feeds the first slot");
    expect (connected (rack, b, metronomeNode) && connected (rack, metronomeNode, master),
            "pre-chain: last slot still feeds the metronome before master");

    // Placement must hold across both branches of rebuildConnections().
    rack.createSplit ("g1", "a", 0, { "l1", "l2" });
    expect (connected (rack, router, looperNode)
                && connected (rack, looperNode, slotId (rack, "a")),
            "pre-chain: split groups fan out from the looper");

    rack.setLooperPostChain (true);
    expect (connected (rack, slotId (rack, "b"), looperNode)
                && connected (rack, looperNode, metronomeNode)
                && connected (rack, metronomeNode, master),
            "post-chain with splits: serial tail feeds looper and metronome before master");
}

static void testMetronomeCommandsThroughGraph()
{
    RackProcessor rack;
    auto& graph = rack.getGraph();
    graph.setPlayConfigDetails (2, 2, 48000.0, 512);
    graph.prepareToPlay (48000.0, 512);

    rack.setMetronomeBpm (90.0f);
    rack.setMetronomeBeatsPerBar (3);
    rack.setMetronomeSubdivision (2);
    rack.setMetronomeLevelDb (-6.0f);
    rack.setMetronomeEnabled (true);

    juce::AudioBuffer<float> buffer (2, 512);
    juce::MidiBuffer midi;
    buffer.clear();
    graph.processBlock (buffer, midi);

    expect (rack.getMetronomeStatus().running, "graph path: enabled metronome publishes running");
    expect (buffer.getMagnitude (0, 0, buffer.getNumSamples()) > 0.0f,
            "graph path: metronome adds a click to silence");
    expect (rack.getMetronomeBpm() == 90.0f && rack.getMetronomeBeatsPerBar() == 3
                && rack.getMetronomeSubdivision() == 2,
            "graph path: metronome settings round-trip through RackProcessor");

    rack.setMetronomeEnabled (false);
    buffer.clear();
    graph.processBlock (buffer, midi);
    expect (! rack.getMetronomeStatus().running
                && buffer.getMagnitude (0, 0, buffer.getNumSamples()) == 0.0f,
            "graph path: disabling cuts the click and publishes stopped");
    graph.releaseResources();
}

static void testLooperCommandsThroughGraph()
{
    // The looper driven exactly as the app drives it: commands through
    // RackProcessor, audio through the whole prepared graph. Guards the
    // message-thread plumbing the hostless LooperProcessor tests can't see.
    RackProcessor rack;
    auto& graph = rack.getGraph();
    graph.setPlayConfigDetails (2, 2, 48000.0, 512);
    graph.prepareToPlay (48000.0, 512);

    juce::AudioBuffer<float> buffer (2, 512);
    juce::MidiBuffer midi;
    const auto run = [&] (float value, int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
        {
            for (int ch = 0; ch < 2; ++ch)
                juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), value, 512);
            graph.processBlock (buffer, midi);
        }
    };
    using Cmd = LooperProcessor::Command;
    using St = LooperProcessor::State;

    rack.looperCommand (Cmd::toggle);
    run (0.5f);
    expect (rack.getLooperStatus().state == St::recording,
            "graph path: toggle arms and the signal triggers recording");
    run (0.5f, 12);
    rack.looperCommand (Cmd::toggle);
    run (0.0f);
    expect (rack.getLooperStatus().state == St::playing, "graph path: the loop closes into playback");

    rack.looperCommand (Cmd::toggle);
    run (0.25f, 14);   // a full overdub pass and change
    rack.looperCommand (Cmd::toggle);
    run (0.0f);
    expect (rack.getLooperStatus().hasUndo, "graph path: the overdub is undoable");
    expect (! rack.getLooperStatus().undoIsRedo, "graph path: a fresh overdub offers undo");

    rack.looperCommand (Cmd::undo);
    run (0.0f);
    expect (rack.getLooperStatus().undoIsRedo, "graph path: after undo the button offers redo");
    rack.looperCommand (Cmd::undo);
    run (0.0f);
    expect (! rack.getLooperStatus().undoIsRedo, "graph path: after redo it offers undo again");

    graph.releaseResources();
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testLooperPlacement();
    testLooperCommandsThroughGraph();
    testMetronomeCommandsThroughGraph();

    testEmptyRackIsPassthrough();
    testSerialChainFollowsSlotOrder();
    testMissingSlotIsWiredLikeAnyOther();
    testSplitLifecycleAndValidation();
    testCreateSplitCanStartInSwitchMode();
    testInsertBumpsGroupPositions();
    testAdjacentGroupDisambiguation();
    testInsertWithoutBeforeGroupLeavesAdjacentGroups();
    testRemovalSlidesAndCollapses();
    testThreeLaneGroupLosesOnlyEmptiedLane();
    testMoveLaneReordersWithoutTouchingMembership();
    testBypassIsHostOwned();
    testRemoveLaneAndDissolve();
    testSplitConnectionsFanOutAndSum();
    testMonoOutputFansOntoBothChannels();
    testMonoOutputMidChainKeepsStereoDownstream();
    testMonoInputPluginIsFedAndStaysStereoOut();
    testPluginWithoutAudioOutputIsRoutedAround();
    testMonoPluginInLaneFeedsItsMixerOnBothChannels();
    testMoveSlotWithinSegment();
    testMoveSlotAcrossSplitBoundary();
    testMoveSlotIntoAndOutOfLane();
    testSwapSlotsTradesPlacesAndRewires();
    testSwapSlotsCrossesLaneBoundariesWithoutMovingSplits();
    testSwapSlotsNoOps();
    testMoveSlotAdjacentGroups();
    testMoveSlotEmptiedLaneStays();
    testMoveSlotIntoNewLane();
    testMoveSlotNoOps();
    testMoveSlotAcrossAdjacentSplit();
    testMoveSlotLaneNoOpWithInterleavedFlatOrder();
    testMoveSlotIntoSwitchedOffLane();
    testInactiveLanesKeepRunning();
    testLaneSwitchFadesInsteadOfCutting();
    testStandbySuspendsEveryPlugin();
    testStandbySuspendsBypassedSlots();
    testStandbySurvivesRebuilds();
    testStandbyIsTheOnlySuspensionReason();
    testStandbyDoesNotBumpRevision();
    testStandbyMuteIsIndependent();
    testStandbyMuteFades();
    testFeedbackGuardTripsOnASteadySqueal();
    testFeedbackGuardCountsWhileASquealIsStillBuilding();
    testFeedbackGuardTripsFastOnSaturation();
    testFeedbackGuardIgnoresPlaying();
    testFeedbackGuardIgnoresSteadyHiss();
    testFeedbackGuardIgnoresADynamicLevel();
    testFeedbackGuardOffNeverTrips();
    testClearingTheFeedbackLatchDoesNotInstantlyRetrip();
    testDisarmingTheGuardDropsTheLatch();
    testFeedbackGuardIgnoresBlocksTheOtherMutesOwn();
    testFeedbackMuteIsIndependent();
    testStandbyMeterIsIndependentOfTheStatusMeter();
    testBypassBatch();
    testApplyPluginState();
    testApplyPluginStateHonoursStandby();
    testApplyPluginStateOnMissingSlot();
    testMidiTunerStateAndMuteReasons();
    testOutputMuteFadesInsteadOfClicking();

    if (failures != 0)
        return 1;

    std::cout << "RackProcessor: all topology cases passed\n";
    return 0;
}
