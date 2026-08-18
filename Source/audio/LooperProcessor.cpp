#include "LooperProcessor.h"

void LooperProcessor::prepareToPlay (double rate, int)
{
    // A host that does not offer the looper never allocates its buffers. The
    // graph prepares every node it owns whether or not the node is connected,
    // so leaving this out of the chain alone would still cost two stereo
    // minutes of float — the largest single allocation in the engine, and one
    // paid per plugin instance.
    if (! available)
    {
        bufferA.setSize (0, 0);
        bufferB.setSize (0, 0);
        maxLoopSamples = 0;
        sampleRate = rate;
        resetToEmpty();
        return;
    }

    levelRampStep = (float) (1.0 / juce::jmax (1.0, rate * levelFadeSeconds));
    seamFadeSamples = juce::jmax (1, (int) (rate * seamFadeSeconds));
    minLoopSamples = juce::jmax (seamFadeSamples * 2, (int) (rate * minLoopSeconds));

    const int wanted = (int) std::ceil (rate * maxLoopSeconds);
    if (wanted != maxLoopSamples || rate != sampleRate)
    {
        // Sample rate changed: the recorded material is at the wrong rate now,
        // so start over. Same-rate re-prepares (device restarts, graph
        // re-preparation) keep the loop.
        maxLoopSamples = wanted;
        bufferA.setSize (2, maxLoopSamples);
        bufferB.setSize (2, maxLoopSamples);
        bufferA.clear();
        bufferB.clear();
        resetToEmpty();
        // A staged load carries material at the old rate — drop it.
        stagedState.store (stagedIdle, std::memory_order_release);
    }
    sampleRate = rate;
}

int LooperProcessor::snapshotLoop (juce::AudioBuffer<float>& dest) const
{
    const int length = juce::jmin (publishedLengthSamples.load (std::memory_order_relaxed),
                                   maxLoopSamples);
    if (length <= 0 || length < minLoopSamples)
        return 0;

    const auto& source = publishedLoopIsA.load (std::memory_order_relaxed) ? bufferA : bufferB;
    dest.setSize (2, length, false, false, true);
    for (int ch = 0; ch < 2; ++ch)
        dest.copyFrom (ch, 0, source, ch, 0, length);
    return length;
}

void LooperProcessor::stageLoadedLoop (juce::AudioBuffer<float>&& buffer, int lengthSamples)
{
    jassert (stagedState.load (std::memory_order_acquire) != stagedReady);
    jassert (buffer.getNumChannels() == 2 && buffer.getNumSamples() >= maxLoopSamples);

    stagedBuffer = std::move (buffer);
    stagedLength = juce::jlimit (0, maxLoopSamples, lengthSamples);
    stagedState.store (stagedReady, std::memory_order_release);
}

void LooperProcessor::resetToEmpty()
{
    state = State::empty;
    loopLength = 0;
    writePos = 0;
    playhead = 0;
    playGain = 0.0f;
    playTarget = 0.0f;
    overdubGain = 0.0f;
    tailRemaining = 0;
    sessionSamples = 0;
    fillRemaining = 0;
    undoAvailable = false;
    undoIsRedo = false;
    unchangedLoad = false;
}

void LooperProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    const int numSamples = buffer.getNumSamples();
    if (buffer.getNumChannels() < 2 || maxLoopSamples == 0 || numSamples <= 0)
        return;

    const auto command = (Command) pendingCommand.exchange (0, std::memory_order_acq_rel);
    if (command != Command::none)
        applyCommand (command);

    if (stagedState.load (std::memory_order_acquire) == stagedReady)
        adoptStagedLoop();

    // Snapshot completion runs before any write this block, so a record tail
    // landing on the same samples still finds the pre-overdub content copied.
    runUndoFill();

    // Armed: recording starts on the first sample that crosses the threshold,
    // so the loop head is the player's first note. Scanned after the command
    // (arm-and-already-playing triggers within this very block) and recording
    // picks up mid-block from the trigger sample itself.
    int recordFrom = 0;
    if (state == State::armed)
    {
        const int trigger = findTrigger (buffer, numSamples);
        if (trigger >= 0)
        {
            state = State::recording;
            writePos = 0;
            recordFrom = trigger;
        }
    }

    if (state == State::recording)
        processRecording (buffer, recordFrom, numSamples);

    // The tail writes into the region playback is about to read, so it must
    // land first. The buffer still carries pure input at this point.
    processRecordTail (buffer, numSamples);

    if (state == State::overdubbing)
        processOverdub (buffer, numSamples);
    else if (state == State::playing)
        processPlayback (buffer, numSamples);

    processStopFade (buffer, numSamples);

    publish();
}

void LooperProcessor::applyCommand (Command command)
{
    switch (command)
    {
        case Command::toggle:
            switch (state)
            {
                case State::empty:
                    resetToEmpty();
                    // Auto-arm off restores the classic pedal behaviour:
                    // recording starts on the press, dead air included.
                    state = armEnabled.load (std::memory_order_relaxed)
                              ? State::armed
                              : State::recording;
                    break;
                case State::armed:
                    // Second press forces the take through a quiet passage —
                    // "record NOW" when the trigger has not fired.
                    state = State::recording;
                    writePos = 0;
                    break;
                case State::recording:
                    closeLoop (State::playing);
                    break;
                case State::playing:
                    beginOverdub();
                    break;
                case State::overdubbing:
                    endOverdub();
                    state = State::playing;
                    break;
                case State::stopped:
                    state = State::playing;
                    playhead = 0;
                    playGain = 0.0f;   // restart fades in; the head is mid-waveform
                    playTarget = 1.0f;
                    fadeActive = false;
                    break;
            }
            break;

        case Command::stop:
            switch (state)
            {
                case State::armed:
                    resetToEmpty();   // nothing captured yet: stop is a cancel
                    break;
                case State::recording:
                    closeLoop (State::stopped);
                    break;
                case State::overdubbing:
                    endOverdub();
                    startStopFade();
                    state = State::stopped;
                    playhead = 0;
                    break;
                case State::playing:
                    startStopFade();
                    state = State::stopped;
                    playhead = 0;
                    break;
                case State::empty:
                case State::stopped:
                    break;
            }
            break;

        case Command::clear:
            if (state == State::playing || state == State::overdubbing)
                startStopFade();
            resetToEmpty();
            break;

        case Command::undo:
            // undoAvailable is only true once the snapshot is complete, and is
            // cleared while recording or overdubbing — so this swap is always
            // between two fully consistent takes. Swapping again redoes.
            if (undoAvailable && (state == State::playing || state == State::stopped))
            {
                loopIsA = ! loopIsA;
                undoIsRedo = ! undoIsRedo;   // the next press reverses this one
            }
            break;

        case Command::none:
            break;
    }
}

void LooperProcessor::adoptStagedLoop()
{
    // Both buffers are full-size, so this is a pure pointer exchange — the
    // displaced loop parks in stagedBuffer until the next load replaces it.
    std::swap (loopBuffer(), stagedBuffer);
    const int length = stagedLength;

    resetToEmpty();
    // A stop fade still running (from the clear that preceded this load)
    // would now read the new material at the old playhead — cut it instead.
    fadeActive = false;
    if (length >= minLoopSamples)
    {
        loopLength = length;
        state = State::playing;
        // Until something writes into it, this loop *is* the session file it
        // came from — the clear-time archive skips it rather than duplicate.
        unchangedLoad = true;
    }
    stagedState.store (stagedConsumed, std::memory_order_release);
}

void LooperProcessor::closeLoop (State target)
{
    if (writePos < minLoopSamples)
    {
        // Mis-tap: nothing loopable was recorded.
        resetToEmpty();
        return;
    }

    loopLength = writePos;
    playhead = 0;
    undoAvailable = false;
    fillRemaining = 0;

    // Carry the performance's tail across the seam: the next seamFade of
    // input keeps being written, faded out, over the loop head.
    tailPos = 0;
    tailRemaining = seamFadeSamples;

    if (target == State::playing)
    {
        // Playback starts at full level: the signal is continuous for the
        // player (their live input never stopped), and the head is the loop's
        // natural downbeat.
        playGain = 1.0f;
        playTarget = 1.0f;
    }
    else
    {
        playGain = 0.0f;
        playTarget = 0.0f;
    }
    state = target;
}

void LooperProcessor::beginOverdub()
{
    state = State::overdubbing;
    overdubGain = 0.0f;      // fade the new layer in over the seam length
    sessionSamples = 0;
    fillRemaining = 0;
    undoAvailable = false;   // the previous undo take is about to be overwritten
    undoIsRedo = false;      // once this session commits, the button undoes it
    unchangedLoad = false;   // the session starts writing into the loop at once
    tailRemaining = 0;       // a pending tail would double-write under the session
    playTarget = 1.0f;
}

void LooperProcessor::endOverdub()
{
    if (sessionSamples >= loopLength)
    {
        undoAvailable = true;
        fillRemaining = 0;
    }
    else
    {
        // The uncovered region of the loop is untouched by this session, so it
        // still equals the pre-overdub content — finish copying it across in
        // amortized slices.
        fillPos = playhead;
        fillRemaining = loopLength - sessionSamples;
    }

    // Fade the overdub layer's cut-off into the following samples.
    tailPos = playhead;
    tailRemaining = seamFadeSamples;
}

void LooperProcessor::startStopFade()
{
    fadeActive = true;
    fadePlayhead = playhead;
    fadeLength = loopLength;
    fadeGain = playGain;
    playGain = 0.0f;
    playTarget = 0.0f;
}

void LooperProcessor::snapshotRegion (int start, int count)
{
    auto& loop = loopBuffer();
    auto& undo = undoBuffer();
    while (count > 0)
    {
        const int run = juce::jmin (count, loopLength - start);
        for (int ch = 0; ch < 2; ++ch)
            undo.copyFrom (ch, start, loop, ch, start, run);
        start = (start + run) % loopLength;
        count -= run;
    }
}

void LooperProcessor::runUndoFill()
{
    if (fillRemaining <= 0)
        return;

    const int count = juce::jmin (undoFillPerBlock, fillRemaining);
    snapshotRegion (fillPos, count);
    fillPos = (fillPos + count) % loopLength;
    fillRemaining -= count;
    if (fillRemaining == 0)
        undoAvailable = true;
}

int LooperProcessor::findTrigger (const juce::AudioBuffer<float>& buffer, int numSamples) const
{
    const float threshold = armThresholdLinear.load (std::memory_order_relaxed);
    for (int i = 0; i < numSamples; ++i)
        if (std::abs (buffer.getSample (0, i)) >= threshold
            || std::abs (buffer.getSample (1, i)) >= threshold)
            return i;
    return -1;
}

void LooperProcessor::processRecording (const juce::AudioBuffer<float>& buffer, int startSample, int numSamples)
{
    auto& loop = loopBuffer();
    const int count = juce::jmin (numSamples - startSample, maxLoopSamples - writePos);
    for (int ch = 0; ch < 2; ++ch)
        loop.copyFrom (ch, writePos, buffer, ch, startSample, count);
    writePos += count;

    if (writePos >= maxLoopSamples)
        closeLoop (State::playing);   // buffer full: auto-close and start looping
}

void LooperProcessor::processRecordTail (const juce::AudioBuffer<float>& buffer, int numSamples)
{
    if (tailRemaining <= 0 || loopLength <= 0)
        return;

    auto& loop = loopBuffer();
    const int count = juce::jmin (numSamples, tailRemaining);
    for (int i = 0; i < count; ++i)
    {
        const float gain = (float) tailRemaining / (float) seamFadeSamples;
        for (int ch = 0; ch < 2; ++ch)
            loop.addSample (ch, tailPos, buffer.getSample (ch, i) * gain);
        tailPos = (tailPos + 1) % loopLength;
        --tailRemaining;
    }
}

void LooperProcessor::processOverdub (juce::AudioBuffer<float>& buffer, int numSamples)
{
    auto& loop = loopBuffer();

    // Snapshot the region this block will write, first pass over the loop only.
    if (sessionSamples < loopLength)
    {
        const int toCopy = juce::jmin (numSamples, loopLength - sessionSamples);
        snapshotRegion (playhead, toCopy);
    }
    sessionSamples = juce::jmin (loopLength, sessionSamples + numSamples);

    for (int i = 0; i < numSamples; ++i)
    {
        playGain = juce::jmin (playTarget, playGain + levelRampStep);
        overdubGain = juce::jmin (1.0f, overdubGain + 1.0f / (float) seamFadeSamples);
        for (int ch = 0; ch < 2; ++ch)
        {
            const float in = buffer.getSample (ch, i);
            // Play the pre-write content, then layer the input on top — the
            // live input is already in the buffer, so adding the just-written
            // sample would double it.
            buffer.addSample (ch, i, loop.getSample (ch, playhead) * playGain);
            loop.addSample (ch, playhead, in * overdubGain);
        }
        playhead = (playhead + 1) % loopLength;
    }
}

void LooperProcessor::processPlayback (juce::AudioBuffer<float>& buffer, int numSamples)
{
    auto& loop = loopBuffer();
    for (int i = 0; i < numSamples; ++i)
    {
        playGain = playTarget > playGain
                     ? juce::jmin (playTarget, playGain + levelRampStep)
                     : juce::jmax (playTarget, playGain - levelRampStep);
        for (int ch = 0; ch < 2; ++ch)
            buffer.addSample (ch, i, loop.getSample (ch, playhead) * playGain);
        playhead = (playhead + 1) % loopLength;
    }
}

void LooperProcessor::processStopFade (juce::AudioBuffer<float>& buffer, int numSamples)
{
    if (! fadeActive)
        return;
    if (fadeLength <= 0 || fadeGain <= 0.0f)
    {
        fadeActive = false;
        return;
    }

    // Keeps rendering the loop for the few ms it takes the gain to land, even
    // after a clear (the buffers are only rewritten by the next recording).
    auto& loop = loopBuffer();
    for (int i = 0; i < numSamples && fadeGain > 0.0f; ++i)
    {
        for (int ch = 0; ch < 2; ++ch)
            buffer.addSample (ch, i, loop.getSample (ch, fadePlayhead) * fadeGain);
        fadePlayhead = (fadePlayhead + 1) % fadeLength;
        fadeGain -= levelRampStep;
    }
    if (fadeGain <= 0.0f)
        fadeActive = false;
}

void LooperProcessor::publish()
{
    publishedState.store ((int) state, std::memory_order_relaxed);

    const bool recording = state == State::recording;
    const float length = sampleRate > 0.0
                           ? (float) ((recording ? writePos : loopLength) / sampleRate)
                           : 0.0f;
    publishedLengthSeconds.store (length, std::memory_order_relaxed);

    float position = 0.0f;
    if (recording)
        position = maxLoopSamples > 0 ? (float) writePos / (float) maxLoopSamples : 0.0f;
    else if (loopLength > 0)
        position = (float) playhead / (float) loopLength;
    publishedPosition.store (position, std::memory_order_relaxed);

    publishedHasUndo.store (undoAvailable, std::memory_order_relaxed);
    publishedUndoIsRedo.store (undoIsRedo, std::memory_order_relaxed);
    publishedUnchangedLoad.store (unchangedLoad, std::memory_order_relaxed);
    publishedLoopIsA.store (loopIsA, std::memory_order_relaxed);
    publishedLengthSamples.store (recording ? writePos : loopLength, std::memory_order_relaxed);
}
