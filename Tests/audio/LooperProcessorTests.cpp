#include <JuceHeader.h>

#include "LooperProcessor.h"

#include <cmath>
#include <iostream>
#include <vector>

/*
    Headless coverage for the looper's state machine and audio path: toggle
    cycle, record/playback fidelity, overdub summing, the amortized undo
    snapshot, the mis-tap discard, and the auto-close at the buffer limit.
    Everything runs synchronously — commands are posted and applied by the
    next processBlock, exactly as they interleave in the app.
*/

namespace
{
    constexpr double rate = 48000.0;
    constexpr int blockSize = 512;

    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    bool near (float a, float b, float tolerance = 1.0e-4f)
    {
        return std::abs (a - b) <= tolerance;
    }

    /** Drives the looper block by block with a deterministic input signal and
        keeps a running sample counter so tests can predict loop content. */
    struct Harness
    {
        explicit Harness (double sampleRate = rate)
        {
            looper.prepareToPlay (sampleRate, blockSize);
        }

        // Never falls below 0.1, so an armed looper triggers on the very first
        // sample and the record/playback arithmetic needs no trigger offset.
        static float signalAt (long n) { return 0.1f + (float) (n % 977) * 0.001f; }

        /** One block of the deterministic signal; returns the processed buffer
            (input + whatever the looper mixed on top). */
        juce::AudioBuffer<float> processSignal()
        {
            juce::AudioBuffer<float> buffer (2, blockSize);
            for (int i = 0; i < blockSize; ++i)
                for (int ch = 0; ch < 2; ++ch)
                    buffer.setSample (ch, i, signalAt (counter + i));
            counter += blockSize;
            looper.processBlock (buffer, midi);
            return buffer;
        }

        juce::AudioBuffer<float> processConstant (float value)
        {
            juce::AudioBuffer<float> buffer (2, blockSize);
            for (int ch = 0; ch < 2; ++ch)
                juce::FloatVectorOperations::fill (buffer.getWritePointer (ch), value, blockSize);
            looper.processBlock (buffer, midi);
            return buffer;
        }

        juce::AudioBuffer<float> processSilence (int blocks = 1)
        {
            juce::AudioBuffer<float> buffer;
            for (int i = 0; i < blocks; ++i)
            {
                buffer = processConstant (0.0f);
            }
            return buffer;
        }

        void command (LooperProcessor::Command c) { looper.postCommand (c); }
        LooperProcessor::State state() const { return looper.getStatus().state; }

        LooperProcessor looper;
        juce::MidiBuffer midi;
        long counter = 0;
    };

    constexpr auto toggle = LooperProcessor::Command::toggle;
    constexpr auto stop   = LooperProcessor::Command::stop;
    constexpr auto clear  = LooperProcessor::Command::clear;
    constexpr auto undo   = LooperProcessor::Command::undo;
    using State = LooperProcessor::State;

    // 12 blocks ≈ 128 ms — comfortably past the 100 ms mis-tap threshold.
    constexpr int loopBlocks = 12;
    constexpr int loopSamples = loopBlocks * blockSize;
}

static void testToggleCycle()
{
    Harness h;
    expect (h.state() == State::empty, "starts empty");

    h.command (toggle);
    h.processSignal();
    expect (h.state() == State::recording, "toggle from empty arms, and the signal triggers recording");

    for (int i = 1; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::playing, "toggle from recording plays");
    expect (near (h.looper.getStatus().lengthSeconds, (float) (loopSamples / rate), 0.02f),
            "closed loop reports its recorded length");

    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::overdubbing, "toggle from playing overdubs");

    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::playing, "toggle from overdubbing returns to playing");

    h.command (stop);
    h.processSilence();
    expect (h.state() == State::stopped, "stop halts playback");

    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::playing, "toggle from stopped restarts");

    h.command (clear);
    h.processSilence();
    expect (h.state() == State::empty, "clear empties the looper");
    expect (! h.looper.getStatus().hasUndo, "clear drops any undo take");
}

static void testRecordPlaybackFidelity()
{
    Harness h;
    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);

    // Playback with silent input must reproduce the recording exactly — the
    // seam tail adds faded *input*, which is zero here.
    bool exact = true;
    for (int block = 0; block < loopBlocks; ++block)
    {
        const auto out = h.processSilence();
        for (int i = 0; i < blockSize && exact; ++i)
            if (! near (out.getSample (0, i), Harness::signalAt (block * blockSize + i))
                || ! near (out.getSample (1, i), Harness::signalAt (block * blockSize + i)))
                exact = false;
    }
    expect (exact, "playback reproduces the recorded signal on both channels");

    // Second pass: it loops.
    const auto out = h.processSilence();
    bool loops = true;
    for (int i = 0; i < blockSize && loops; ++i)
        if (! near (out.getSample (0, i), Harness::signalAt (i)))
            loops = false;
    expect (loops, "playback wraps back to the loop head");
    expect (near (h.looper.getStatus().position, (float) blockSize / (float) loopSamples, 0.01f),
            "position tracks the playhead after the wrap");
}

static void testOverdubSumsAndFullPassUndo()
{
    Harness h;
    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);
    h.processSilence();   // playing; playhead now at blockSize
    int playhead = blockSize;

    // Steps playback forward to `target`, then returns the block [target,
    // target + blockSize) — playback advances exactly one block per call.
    auto blockAt = [&] (int target)
    {
        const int toGo = ((target - playhead) % loopSamples + loopSamples) % loopSamples;
        h.processSilence (toGo / blockSize);
        playhead = (target + blockSize) % loopSamples;
        return h.processSilence();
    };
    auto matches = [&] (const juce::AudioBuffer<float>& out, int start, float layered)
    {
        for (int i = 0; i < blockSize; ++i)
            if (! near (out.getSample (0, i), Harness::signalAt (start + i) + layered))
                return false;
        return true;
    };

    h.command (toggle);   // overdub a constant layer for one full pass
    for (int i = 0; i < loopBlocks; ++i)
        h.processConstant (0.25f);
    playhead = (playhead + loopSamples) % loopSamples;
    h.command (toggle);
    h.processSilence();
    playhead = (playhead + blockSize) % loopSamples;
    expect (h.state() == State::playing, "overdub session committed");
    expect (h.looper.getStatus().hasUndo, "a full-pass overdub is undoable immediately");
    expect (! h.looper.getStatus().undoIsRedo, "a fresh overdub means the next press undoes");

    // Well past the overdub's fade-in (the session started at blockSize, its
    // write gain lands within ~480 samples) the loop must hold old + 0.25.
    const int checkFrom = 4 * blockSize;
    expect (matches (blockAt (checkFrom), checkFrom, 0.25f),
            "overdub layered the new signal onto the loop");

    h.command (undo);
    expect (matches (blockAt (checkFrom), checkFrom, 0.0f),
            "undo restores the pre-overdub loop");
    expect (h.looper.getStatus().undoIsRedo, "after an undo the next press is a redo");

    h.command (undo);
    expect (matches (blockAt (checkFrom), checkFrom, 0.25f),
            "undo again redoes the overdub");
    expect (! h.looper.getStatus().undoIsRedo, "after the redo the next press undoes again");
}

static void testShortOverdubAmortizedUndo()
{
    Harness h;
    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);
    h.processSilence();

    h.command (toggle);           // overdub only 2 of 12 blocks: [blockSize, 3·blockSize)
    bool undoDuringSession = false;
    h.processConstant (0.25f);
    undoDuringSession = undoDuringSession || h.looper.getStatus().hasUndo;
    h.processConstant (0.25f);
    undoDuringSession = undoDuringSession || h.looper.getStatus().hasUndo;
    expect (! undoDuringSession, "hasUndo never shows while the session is open");

    h.command (toggle);
    h.processSilence();
    // 12 − 2 blocks = 5120 samples remained to snapshot — within one block's
    // 8192-sample fill budget, so the take is undoable by now.
    int guard = 0;
    while (! h.looper.getStatus().hasUndo && guard++ < 16)
        h.processSilence();
    expect (h.looper.getStatus().hasUndo, "the amortized fill completes and publishes hasUndo");

    h.command (undo);
    h.processSilence();
    // Restart from the head and let the 15 ms level ramp land, then verify the
    // overdubbed region [blockSize, 3·blockSize) reverted to the original take.
    h.command (stop);
    h.processSilence();
    h.command (toggle);
    h.processSilence (2);                 // [0, 2·blockSize) — the ramp lands inside it
    const auto out = h.processSilence();  // [2·blockSize, 3·blockSize), inside the overdub region
    bool restored = true;
    for (int i = 0; i < blockSize && restored; ++i)
        if (! near (out.getSample (0, i), Harness::signalAt (2 * blockSize + i)))
            restored = false;
    expect (restored, "undo after a partial-pass overdub restores the original take");
}

static void testArmedTriggersOnInput()
{
    Harness h;
    h.command (toggle);
    h.processSilence (3);
    expect (h.state() == State::armed, "toggle from empty arms; silence never starts the take");

    // Trigger mid-block: 412 samples of silence, then signal. The recording
    // must start at the trigger sample — no dead air in the loop head.
    juce::AudioBuffer<float> block (2, blockSize);
    block.clear();
    const int triggerAt = 412;
    for (int i = triggerAt; i < blockSize; ++i)
        for (int ch = 0; ch < 2; ++ch)
            block.setSample (ch, i, 0.3f);
    h.looper.processBlock (block, h.midi);
    expect (h.state() == State::recording, "input above the threshold starts recording");

    for (int i = 0; i < loopBlocks; ++i)
        h.processConstant (0.3f);
    h.command (toggle);
    const auto out = h.processSilence();
    expect (h.state() == State::playing, "the armed take closes into playback");
    expect (near (out.getSample (0, 0), 0.3f) && near (out.getSample (1, 0), 0.3f),
            "the loop head is the trigger sample, not the leading silence");
    const float expectedSeconds = (float) ((blockSize - triggerAt + loopBlocks * blockSize) / rate);
    expect (near (h.looper.getStatus().lengthSeconds, expectedSeconds, 0.005f),
            "loop length counts from the trigger, not from arming");
}

static void testArmedForceAndCancel()
{
    Harness h;
    h.command (toggle);
    h.processSilence();
    h.command (toggle);           // second press: record NOW, silence or not
    h.processSilence();
    expect (h.state() == State::recording, "toggle while armed forces recording through silence");
    h.command (clear);
    h.processSilence();
    expect (h.state() == State::empty, "clear discards the forced take");

    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::armed, "re-arming works after a clear");
    h.command (stop);
    h.processSilence();
    expect (h.state() == State::empty, "stop while armed cancels back to empty");
}

static void testArmConfiguration()
{
    // Auto-arm off: toggle records immediately, silence and all.
    Harness h;
    h.looper.setArmEnabled (false);
    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::recording, "with auto-arm off, toggle records immediately");
    h.command (clear);
    h.processSilence();

    // A raised (less sensitive) threshold ignores quiet input.
    h.looper.setArmEnabled (true);
    h.looper.setArmThresholdDb (-20.0f);   // linear 0.1
    h.command (toggle);
    h.processConstant (0.05f);
    expect (h.state() == State::armed, "input under the raised threshold does not trigger");
    h.processConstant (0.2f);
    expect (h.state() == State::recording, "input over the raised threshold does");
    h.command (clear);
    h.processSilence();

    // Out-of-range values clamp instead of arming on the noise floor.
    h.looper.setArmThresholdDb (-500.0f);
    expect (near (h.looper.getArmThresholdDb(), -70.0f), "threshold clamps at the quiet end");
    h.looper.setArmThresholdDb (0.0f);
    expect (near (h.looper.getArmThresholdDb(), -20.0f), "threshold clamps at the loud end");
}

static void testMisTapDiscards()
{
    Harness h;
    h.command (toggle);
    h.processSignal();            // ~11 ms recorded — below the 100 ms minimum
    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::empty, "closing a sub-minimum recording discards it");
}

static void testStopWhileRecordingKeepsTheLoop()
{
    Harness h;
    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (stop);
    h.processSilence();
    expect (h.state() == State::stopped, "stop while recording closes into stopped");
    expect (near (h.looper.getStatus().lengthSeconds, (float) (loopSamples / rate), 0.02f),
            "the stopped loop keeps its recorded length");

    h.command (toggle);
    auto out = h.processSilence (2);   // past the restart ramp
    out = h.processSilence();
    bool audible = out.getMagnitude (0, 0, blockSize) > 0.0f;
    expect (audible, "the loop recorded before stop plays after restart");
}

static void testAutoCloseAtBufferLimit()
{
    Harness h (8000.0);           // small rate keeps the 60 s limit fast to fill
    const int maxSamples = (int) std::ceil (8000.0 * LooperProcessor::maxLoopSeconds);
    h.command (toggle);
    const int blocks = maxSamples / blockSize + 2;
    for (int i = 0; i < blocks && h.state() != State::playing; ++i)
        h.processSignal();
    expect (h.state() == State::playing, "hitting the buffer limit auto-closes into playback");
    expect (near (h.looper.getStatus().lengthSeconds, (float) LooperProcessor::maxLoopSeconds, 0.2f),
            "the auto-closed loop spans the full buffer");
}

static void testSnapshotLoop()
{
    Harness h;
    juce::AudioBuffer<float> copy;
    expect (h.looper.snapshotLoop (copy) == 0, "an empty looper snapshots nothing");

    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();

    // Mid-recording: the partial take recorded so far is what a clear would
    // archive, so the snapshot covers exactly the samples written to date.
    int length = h.looper.snapshotLoop (copy);
    expect (length == loopSamples, "a recording snapshots the take so far");
    expect (near (copy.getSample (0, 100), Harness::signalAt (100)),
            "the partial snapshot carries the recorded signal");

    h.command (toggle);
    h.processSilence();
    length = h.looper.snapshotLoop (copy);
    expect (length == loopSamples, "a closed loop snapshots its full length");
    bool matches = true;
    for (int i = 0; i < length && matches; i += 997)
        matches = near (copy.getSample (0, i), Harness::signalAt (i), 2.0e-3f);
    expect (matches, "the snapshot equals the recorded loop");

    h.command (toggle);          // playing -> overdub
    h.processSilence();
    h.command (toggle);          // -> playing (undo take exists in the other buffer)
    h.processSilence();
    h.command (undo);
    h.processSilence();
    length = h.looper.snapshotLoop (copy);
    expect (length == loopSamples, "after an undo swap the snapshot follows the live buffer");
}

static void testStagedLoadAdoption()
{
    Harness h;
    const int maxSamples = (int) std::ceil (rate * LooperProcessor::maxLoopSeconds);

    // A staged buffer must be full-size; the audio thread adopts by swapping.
    juce::AudioBuffer<float> loaded (2, maxSamples);
    loaded.clear();
    for (int i = 0; i < loopSamples; ++i)
        for (int ch = 0; ch < 2; ++ch)
            loaded.setSample (ch, i, Harness::signalAt (i));

    h.looper.stageLoadedLoop (std::move (loaded), loopSamples);
    expect (! h.looper.isStagedLoadConsumed(), "the load is pending until a block runs");

    h.processSilence();
    expect (h.looper.isStagedLoadConsumed(), "the next block adopts the staged loop");
    expect (h.state() == State::playing, "a loaded session starts playing immediately");
    expect (near (h.looper.getStatus().lengthSeconds, (float) (loopSamples / rate), 0.02f),
            "the loaded loop reports the staged length");

    h.command (toggle);          // stopped -> playing
    auto out = h.processSilence (3);   // past the restart fade
    expect (out.getMagnitude (0, 0, blockSize) > 0.0f, "the loaded audio is audible on play");

    // The loaded loop behaves like a recorded one: snapshot (what a clear
    // would archive) returns the staged material.
    juce::AudioBuffer<float> copy;
    expect (h.looper.snapshotLoop (copy) == loopSamples, "a loaded loop snapshots like a recorded one");
    expect (near (copy.getSample (0, 200), Harness::signalAt (200)),
            "the snapshot of a loaded loop carries the staged samples");
}

static void testStagedLoadReplacesCurrentLoop()
{
    Harness h;
    const int maxSamples = (int) std::ceil (rate * LooperProcessor::maxLoopSeconds);

    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);
    h.processSilence();
    expect (h.state() == State::playing, "precondition: a loop is playing");

    juce::AudioBuffer<float> loaded (2, maxSamples);
    loaded.clear();
    // A different length than the playing loop proves the takeover; it must
    // stay above the 100 ms mis-tap minimum, which a real session always is
    // (snapshotLoop never archives anything shorter).
    const int loadedLength = loopSamples - 2 * blockSize;
    for (int i = 0; i < loadedLength; ++i)
        for (int ch = 0; ch < 2; ++ch)
            loaded.setSample (ch, i, 0.25f);

    h.looper.stageLoadedLoop (std::move (loaded), loadedLength);
    h.processSilence();
    expect (h.state() == State::playing, "a load over a playing loop takes over in playback");
    expect (near (h.looper.getStatus().lengthSeconds, (float) (loadedLength / rate), 0.02f),
            "the takeover reports the loaded length");
    expect (! h.looper.getStatus().hasUndo, "a takeover drops the undo history");
}

static void testUnchangedSinceLoadFlag()
{
    Harness h;
    const int maxSamples = (int) std::ceil (rate * LooperProcessor::maxLoopSeconds);

    expect (! h.looper.isLoopUnchangedSinceLoad(), "an empty looper holds no loaded session");

    // A recorded take is not a load.
    h.command (toggle);
    for (int i = 0; i < loopBlocks; ++i)
        h.processSignal();
    h.command (toggle);
    h.processSilence();
    expect (! h.looper.isLoopUnchangedSinceLoad(), "a recorded loop is not an unmodified load");

    auto makeLoaded = [&]
    {
        juce::AudioBuffer<float> loaded (2, maxSamples);
        loaded.clear();
        for (int i = 0; i < loopSamples; ++i)
            for (int ch = 0; ch < 2; ++ch)
                loaded.setSample (ch, i, 0.25f);
        return loaded;
    };

    h.looper.stageLoadedLoop (makeLoaded(), loopSamples);
    h.processSilence();
    expect (h.looper.isLoopUnchangedSinceLoad(), "a freshly adopted load is unmodified");

    // Stop and restart never write into the loop.
    h.command (stop);
    h.processSilence();
    h.command (toggle);
    h.processSilence();
    expect (h.looper.isLoopUnchangedSinceLoad(), "stop and restart keep the load unmodified");

    // Overdubbing writes immediately — the flag drops on entry, not on commit.
    h.command (toggle);
    h.processSilence();
    expect (! h.looper.isLoopUnchangedSinceLoad(), "starting an overdub modifies the load");

    h.command (clear);
    h.processSilence();
    expect (! h.looper.isLoopUnchangedSinceLoad(), "clear drops the flag with the loop");

    // The flag re-arms on the next load.
    h.looper.stageLoadedLoop (makeLoaded(), loopSamples);
    h.processSilence();
    expect (h.looper.isLoopUnchangedSinceLoad(), "the next load is unmodified again");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testToggleCycle();
    testRecordPlaybackFidelity();
    testOverdubSumsAndFullPassUndo();
    testShortOverdubAmortizedUndo();
    testArmedTriggersOnInput();
    testArmedForceAndCancel();
    testArmConfiguration();
    testMisTapDiscards();
    testStopWhileRecordingKeepsTheLoop();
    testAutoCloseAtBufferLimit();
    testSnapshotLoop();
    testStagedLoadAdoption();
    testStagedLoadReplacesCurrentLoop();
    testUnchangedSinceLoadFlag();

    if (failures != 0)
        return 1;

    std::cout << "LooperProcessor: all cases passed\n";
    return 0;
}
