#pragma once

#include <JuceHeader.h>

#include <functional>
#include <memory>
#include <vector>

/**
    Opens every MIDI input on the machine — hot-plug included — and forwards
    the stream to the web UI, reduced to the three trigger-capable kinds:
    controller changes, program changes and note-ons. The UI owns what the
    messages mean (rig/scene switching, tuner toggle, MIDI learn); this class
    is transport only.

    Devices are opened directly via juce::MidiInput, never through
    AudioDeviceManager, whose MIDI restore path is deliberately bypassed (see
    the MIDI note in CMakeLists.txt). Hot-plug is a ~2 s poll of
    getAvailableDevices() rather than MidiDeviceListConnection: the poll is
    cheap and works identically on every backend, including the legacy winmm
    one this app is pinned to.

    Threading: construction, destruction, openDeviceNames() and both callbacks
    are message-thread only. handleIncomingMidiMessage arrives on a system MIDI
    thread; it appends to a locked pending list — coalescing CC values per
    (channel, number) so an expression-pedal sweep cannot flood the bridge,
    while values that cross the press threshold are kept as separate events
    so a quick footswitch tap never loses its press — and schedules a single
    async flush, so the UI sees at most one batch per message pump no matter
    what a controller sends.
*/
class MidiInputManager : private juce::MidiInputCallback,
                        private juce::Timer
{
public:
    /** Both callbacks fire on the message thread. onEvents receives an array
        of { type: "cc"|"pc"|"note", channel: 1-16, number: 0-127,
        value: 0-127 } objects; onDevicesChanged the open inputs' names,
        only when the set actually changed. */
    MidiInputManager (std::function<void (const juce::var&)> onEvents,
                      std::function<void (const juce::StringArray&)> onDevicesChanged);
    ~MidiInputManager() override;

    juce::StringArray openDeviceNames() const;

    /** Diffs available devices against the open set; opens the new, drops the
        vanished, reports when anything changed. The hot-plug timer calls this
        every ~2 s; the UI's manual refresh calls it directly so the reply
        reflects this instant, not the last poll. Message thread only. */
    void refreshDevices();

private:
    void timerCallback() override; // hot-plug poll
    void handleIncomingMidiMessage (juce::MidiInput* source,
                                    const juce::MidiMessage& message) override;
    void flushPending();

    struct PendingEvent
    {
        const char* type;    // "cc" | "pc" | "note" (static strings)
        int channel, number, value;
    };

    std::function<void (const juce::var&)>         onEvents;
    std::function<void (const juce::StringArray&)> onDevicesChanged;

    std::vector<std::unique_ptr<juce::MidiInput>> inputs;

    juce::CriticalSection     pendingLock;
    std::vector<PendingEvent> pending;        // guarded by pendingLock
    bool                      flushScheduled = false; // guarded by pendingLock

    // callAsync guard: a flush landing after destruction must be a no-op.
    std::shared_ptr<bool> alive = std::make_shared<bool> (true);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MidiInputManager)
};
