#pragma once

#include <JuceHeader.h>
#include "HostServices.h"
#include "PlectrifyEngine.h"

#include <atomic>
#include <memory>
#include <utility>

/**
    Plectrify as a VST3 plugin: the same engine the standalone app runs, hosted
    inside a DAW on a guitar track. The DAW owns the audio device, MIDI routing
    and the window, so this processor is the engine's HostServices — it answers
    the device-shaped questions from what the host gave it, and reports the
    chain's latency upward where the standalone had nothing to report to.

    prepareToPlay/processBlock take over the standalone's AudioProcessorPlayer
    job: configure the rack's AudioProcessorGraph and drive it. Topology edits
    still happen on the message thread inside the engine with the graph
    suspended; processBlock honours that suspension exactly as the player did,
    clearing the buffer under the graph's callback lock.

    Both builds read the same per-user data root, so rigs, patches, installed
    packages and the TONE3000 account are shared with the standalone by
    construction.
*/
class PlectrifyAudioProcessor : public juce::AudioProcessor,
                                public plectrify::HostServices
{
public:
    PlectrifyAudioProcessor();
    ~PlectrifyAudioProcessor() override;

    PlectrifyEngine& getEngine() noexcept { return *engine; }

    /** The editor's remembered size moved: it rides the host-saved document,
        so the state cache has to be re-captured and the project marked. */
    void editorSizeChanged();

    // --- juce::AudioProcessor ---------------------------------------------
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) override;

    /** Both forwarded to the rack's graph, which is a separate AudioProcessor
        the host never sees and therefore never configures itself. */
    void setPlayHead (juce::AudioPlayHead* newPlayHead) override;
    void setNonRealtime (bool isNonRealtime) noexcept override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override                     { return true; }

    const juce::String getName() const override         { return "Plectrify"; }
    bool acceptsMidi() const override                   { return true; }
    bool producesMidi() const override                  { return false; }
    bool isMidiEffect() const override                  { return false; }
    double getTailLengthSeconds() const override        { return 0.0; }

    int getNumPrograms() override                       { return 1; }
    int getCurrentProgram() override                    { return 0; }
    void setCurrentProgram (int) override               {}
    const juce::String getProgramName (int) override    { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    // Host-saved state: the engine's one JSON document — the rack with every
    // hosted plugin's tone, the split topology, the page's session metadata
    // (knob mappings, names, colours, scenes) and the fixed-node settings —
    // so a DAW project reload restores the whole rig. getState may be called
    // off the message thread (background autosave); the engine serves a cached
    // capture there and a fresh one on the message thread.
    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // --- plectrify::HostServices ------------------------------------------
    plectrify::HostCapabilities capabilities() const override;
    /** The host's prepareToPlay values, or sensible defaults before the first
        prepare (a DAW may restore state, and ask for plugins to be built,
        before it ever starts the transport). */
    std::pair<double, int> currentRateAndBlock() const override;
    // The DAW owns the device, so the device-shaped diagnostics are its to
    // report: CPU shows idle, xruns and driver latency read as unknown, and
    // the About block's audio group stays absent.
    double cpuLoad() const override                     { return 0.0; }
    int audioXRuns() const override                     { return -1; }
    int deviceLatencySamples() const override           { return -1; }
    juce::var audioDeviceInfo() const override          { return {}; }
    /** Always true: suspension is the host's business (offline render, freeze,
        transport), never the plugin's — capabilities().autoStandby is false,
        so the machinery is parked; this keeps standbyIsBlocked() honest too. */
    bool blocksAutoStandby() const override             { return true; }
    const char* hostKind() const override               { return "plugin"; }
    bool capturesHostState() const override             { return true; }
    void engineSettingsChanged() override;
    void graphLatencyChanged (int totalLatencySamples) override;
    /** Flushes host MIDI collected by processBlock to the page's midiEvents
        stream — the plugin's stand-in for MidiInputManager's flush. */
    void onEngineTick() override;
    /** The page's resize grip. No AU host offers frame dragging (AUv2 has no
        way to declare a view resizable), so the size arrives from the page
        and the editor pushes it out through the wrapper, which every host
        honours. */
    void handleSetEditorSize (const juce::var& payload) override;

private:
    /** Mark the engine's state cache stale and tell the host its project moved.
        The flag matters: only withNonParameterStateChanged reaches the VST3
        wrapper's setDirty. */
    void markProjectDirty();

    std::unique_ptr<PlectrifyEngine> engine;

    std::atomic<double> preparedSampleRate { 0.0 };
    std::atomic<int>    preparedBlockSize  { 0 };

    // --- Host MIDI → the page's midiEvents stream -------------------------
    // processBlock filters the host's MidiBuffer down to the three
    // trigger-capable kinds and pushes them here lock-free; onEngineTick
    // drains, coalesces exactly as MidiInputManager does, and emits. A full
    // FIFO drops events — trigger MIDI, not a stream anyone records.
    struct HostMidiEvent
    {
        juce::uint8 kind;      // 0 = cc, 1 = pc, 2 = note
        juce::uint8 channel;   // 1-16
        juce::uint8 number;    // 0-127
        juce::uint8 value;     // 0-127
    };
    juce::AbstractFifo hostMidiFifo { 256 };
    HostMidiEvent hostMidiEvents[256] = {};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PlectrifyAudioProcessor)
};
