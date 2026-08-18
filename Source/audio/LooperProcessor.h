#pragma once

#include <JuceHeader.h>

#include "PassthroughProcessor.h"

#include <atomic>

/**
    Fixed looper node: records the signal flowing through it into a
    preallocated loop buffer and mixes the loop back on top of the live
    signal. A single-loop, Ditto-style pedal — one main toggle cycles
    record -> play -> overdub, with separate stop / clear / undo actions and
    one level of overdub undo (pressing undo again redoes).

    With auto-arm on (the default), the first toggle arms rather than
    recording outright: recording starts on the first input sample crossing
    the arm threshold, so the loop head is the player's first note — no dead
    air from the walk between screen and guitar. A pedal press mid-playing
    triggers within the same block (inaudibly "immediate"), and toggling
    again while armed forces recording through a quiet passage. Stop or clear
    while armed cancels back to empty. With auto-arm off, toggle records
    immediately, the classic pedal behaviour. Both the switch and the
    threshold are message-thread atomics, changeable live.

    Threading: the message thread posts commands via postCommand() and reads
    getStatus(); both are single atomics. Everything else — the state
    machine, buffers, fades, the undo snapshot — is audio-thread-only.
    processBlock never allocates, locks or blocks; both loop buffers are
    sized once in prepareToPlay (message thread, audio suspended).

    Two message-thread paths touch the loop audio itself. snapshotLoop()
    copies the published live buffer without a lock — the only concurrent
    writer is an in-flight record/overdub pass, and a torn read there is
    audible only in the copy, never live. stageLoadedLoop() hands a
    full-size loaded buffer to the audio thread, which adopts it at the next
    block start with an O(1) pointer swap and lands in the stopped state.

    Undo never copies the whole loop in one callback: while overdubbing, the
    region about to be written is snapshotted just ahead of the write, and any
    remainder is filled in amortized slices after the session ends. hasUndo is
    published only once the snapshot is complete.
*/
class LooperProcessor final : public PassthroughProcessor
{
public:
    enum class Command { none = 0, toggle, stop, clear, undo };
    enum class State { empty = 0, armed, recording, playing, overdubbing, stopped };

    struct Status
    {
        State state = State::empty;
        float lengthSeconds = 0.0f;  // while recording: elapsed record time
        float position = 0.0f;       // 0..1 playhead; while recording: fill of the max length
        bool hasUndo = false;
        // Undo is a swap, so one press undoes and the next redoes: true when
        // the next press brings the overdub back. Lets the UI label the
        // button with what it will actually do.
        bool undoIsRedo = false;
    };

    LooperProcessor() : PassthroughProcessor ("Looper") {}

    /** Message thread. Commands are latched into one atomic slot and applied
        at the start of the next block; foot presses never arrive faster than
        a block, so last-wins is safe. */
    void postCommand (Command command) noexcept
    {
        pendingCommand.store ((int) command, std::memory_order_release);
    }

    /** Message thread. */
    Status getStatus() const noexcept
    {
        return { (State) publishedState.load (std::memory_order_relaxed),
                 publishedLengthSeconds.load (std::memory_order_relaxed),
                 publishedPosition.load (std::memory_order_relaxed),
                 publishedHasUndo.load (std::memory_order_relaxed),
                 publishedUndoIsRedo.load (std::memory_order_relaxed) };
    }

    /** Message thread. True while the looper holds or is capturing audio the
        user can hear looping — the auto-standby detector must not park a rig
        whose loop is still playing under a silent guitar. Armed counts: the
        user is explicitly waiting to play, and parking would eat the note
        that was meant to trigger the take. */
    bool isActive() const noexcept
    {
        const auto currentState = (State) publishedState.load (std::memory_order_relaxed);
        return currentState == State::armed || currentState == State::recording
            || currentState == State::playing || currentState == State::overdubbing;
    }

    /** Message thread. Copies the loop the user can currently hear — or the
        take recorded so far while recording — into dest and returns its
        length in samples; 0 when nothing worth saving is held (empty, armed,
        or shorter than minLoopSeconds). See the class comment for the
        benign-race contract. */
    int snapshotLoop (juce::AudioBuffer<float>& dest) const;

    /** Message thread. Stages a loaded loop for the audio thread to adopt at
        the next block start. The buffer MUST be stereo and allocated at the
        full max-loop size (see prepareToPlay) so the adoption is a pure
        pointer swap. One load in flight at a time: stage the next only after
        isStagedLoadConsumed(). A takeover, not a merge — any current loop and
        undo are dropped. */
    void stageLoadedLoop (juce::AudioBuffer<float>&& buffer, int lengthSamples);
    bool isStagedLoadConsumed() const noexcept
    {
        return stagedState.load (std::memory_order_acquire) == stagedConsumed;
    }

    /** Message thread. True while the held loop is a staged load the player
        has not touched since — no overdub, undo or new take. Such a loop is
        byte-for-byte the session it was loaded from, so archiving it again
        would only duplicate the file. */
    bool isLoopUnchangedSinceLoad() const noexcept
    {
        return publishedUnchangedLoad.load (std::memory_order_relaxed);
    }

    /** Message thread. The rate the loop buffers were prepared at — the rate
        a snapshot plays back at. 0 before the first prepare. */
    double getLoopSampleRate() const noexcept { return sampleRate; }

    void prepareToPlay (double rate, int blockSize) override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override;

    /** Whether this host offers the looper at all. Set once before the graph is
        prepared (see RackProcessor::setToolAvailability); false skips the loop
        buffers entirely, so the commands and getters below stay callable but
        answer for an empty looper that is also out of the chain. */
    void setAvailable (bool isAvailable) noexcept { available = isAvailable; }
    bool isAvailable() const noexcept { return available; }

    /** Message thread. Auto-arm off makes toggle record immediately. */
    void setArmEnabled (bool enabled) noexcept { armEnabled.store (enabled, std::memory_order_relaxed); }
    bool isArmEnabled() const noexcept { return armEnabled.load (std::memory_order_relaxed); }

    /** Message thread. What counts as "the player started", in dBFS at the
        looper's tap point. Clamped to a sane range: below -70 the rig's own
        noise floor triggers, above -20 soft playing never does. */
    void setArmThresholdDb (float db) noexcept
    {
        const float clamped = juce::jlimit (minArmThresholdDb, maxArmThresholdDb, db);
        armThresholdDb.store (clamped, std::memory_order_relaxed);
        armThresholdLinear.store (juce::Decibels::decibelsToGain (clamped), std::memory_order_relaxed);
    }
    float getArmThresholdDb() const noexcept { return armThresholdDb.load (std::memory_order_relaxed); }

    /** ~23 MB per stereo buffer at 48 kHz (x2 with the undo buffer) — plenty
        for phrase looping without making the app balloon. */
    static constexpr double maxLoopSeconds = 60.0;
    static constexpr float defaultArmThresholdDb = -40.0f;
    static constexpr float minArmThresholdDb = -70.0f;
    static constexpr float maxArmThresholdDb = -20.0f;

private:
    void applyCommand (Command command);
    void adoptStagedLoop();
    void resetToEmpty();
    void closeLoop (State target);
    void beginOverdub();
    void endOverdub();
    void startStopFade();
    void runUndoFill();
    /** First sample at or above the arm threshold on either channel, -1 if
        the block stays quiet. */
    int findTrigger (const juce::AudioBuffer<float>& buffer, int numSamples) const;
    void processRecording (const juce::AudioBuffer<float>& buffer, int startSample, int numSamples);
    void processRecordTail (const juce::AudioBuffer<float>& buffer, int numSamples);
    void processOverdub (juce::AudioBuffer<float>& buffer, int numSamples);
    void processPlayback (juce::AudioBuffer<float>& buffer, int numSamples);
    void processStopFade (juce::AudioBuffer<float>& buffer, int numSamples);
    void publish();

    juce::AudioBuffer<float>& loopBuffer() noexcept { return loopIsA ? bufferA : bufferB; }
    juce::AudioBuffer<float>& undoBuffer() noexcept { return loopIsA ? bufferB : bufferA; }
    /** loop -> undo, `count` samples starting at `start`, wrapping at loopLength. */
    void snapshotRegion (int start, int count);

    // Blend length for every write seam (loop close, overdub start/end) and
    // ramp length for play start/stop — same feel as OutputLevelProcessor.
    static constexpr double seamFadeSeconds = 0.010;
    static constexpr double levelFadeSeconds = 0.015;
    static constexpr int undoFillPerBlock = 8192;
    // A loop shorter than this is a mis-tap, not music: discard instead of
    // looping a click.
    static constexpr double minLoopSeconds = 0.1;

    // --- cross-thread (single atomics each way) -----------------------------
    std::atomic<int> pendingCommand { 0 };
    std::atomic<bool> armEnabled { true };
    std::atomic<float> armThresholdDb { defaultArmThresholdDb };
    // 10^(-40/20) — kept in step with armThresholdDb by setArmThresholdDb().
    std::atomic<float> armThresholdLinear { 0.01f };
    std::atomic<int> publishedState { 0 };
    std::atomic<float> publishedLengthSeconds { 0.0f };
    std::atomic<float> publishedPosition { 0.0f };
    std::atomic<bool> publishedHasUndo { false };
    std::atomic<bool> publishedUndoIsRedo { false };
    std::atomic<bool> publishedUnchangedLoad { false };
    // Which buffer holds the live loop and how much of it — lets snapshotLoop
    // read the right material from the message thread.
    std::atomic<bool> publishedLoopIsA { true };
    std::atomic<int> publishedLengthSamples { 0 };

    // Staged session load: the message thread fills stagedBuffer/stagedLength,
    // then release-stores ready; the audio thread swaps it in and stores
    // consumed. The swapped-out old loop stays allocated here until the next
    // load (one extra buffer retained — the price of a lock-free handoff).
    static constexpr int stagedIdle = 0, stagedReady = 1, stagedConsumed = 2;
    juce::AudioBuffer<float> stagedBuffer;
    int stagedLength = 0;
    std::atomic<int> stagedState { stagedIdle };

    // --- audio-thread-only --------------------------------------------------
    bool available = true;                       // see setAvailable
    juce::AudioBuffer<float> bufferA, bufferB;   // sized in prepareToPlay
    bool loopIsA = true;                         // which buffer is the loop (other is undo)
    double sampleRate = 0.0;
    int maxLoopSamples = 0;
    int minLoopSamples = 0;
    int seamFadeSamples = 0;
    float levelRampStep = 1.0f;

    State state = State::empty;
    int loopLength = 0;
    int writePos = 0;                // recording head
    int playhead = 0;
    float playGain = 0.0f;           // ramped toward playTarget per sample
    float playTarget = 0.0f;
    float overdubGain = 0.0f;        // write-gain fade-in at overdub start

    // Faded continuation of the input written past a record/overdub close so
    // the loop seam carries the performance's tail instead of a hard cut.
    int tailPos = 0;
    int tailRemaining = 0;

    // Amortized completion of the undo snapshot after a partial overdub pass.
    int sessionSamples = 0;          // samples covered by the current overdub session
    int fillPos = 0;
    int fillRemaining = 0;
    bool undoAvailable = false;
    bool undoIsRedo = false;         // swap parity: the next undo press redoes
    // The loop is a staged load nobody has recorded over, overdubbed or undone
    // since — see isLoopUnchangedSinceLoad(). Cleared by every write path.
    bool unchangedLoad = false;

    // Short rendered fade-out after stop/clear so playback never hard-cuts.
    bool fadeActive = false;
    int fadePlayhead = 0;
    int fadeLength = 0;
    float fadeGain = 0.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LooperProcessor)
};
