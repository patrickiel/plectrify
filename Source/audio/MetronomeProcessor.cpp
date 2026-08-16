#include "MetronomeProcessor.h"

#include <cmath>

void MetronomeProcessor::prepareToPlay (double rate, int)
{
    sampleRate = rate;
    clickSamples = juce::jmax (1, (int) std::lround (clickSeconds * rate));
    // A rate change restarts the bar rather than trying to rescale a
    // countdown measured in samples of the old rate.
    resetBar();
    beatVoice.reset();
    subVoice.reset();
}

void MetronomeProcessor::resetBar() noexcept
{
    tickIndex = 0;
    currentTick = 0;
    // Zero, not samplesPerTick: the downbeat fires on the very next sample, so
    // switching on or tapping lands the click under the press.
    samplesToNextTick = 0.0;
}

void MetronomeProcessor::fireTick (int tick, int division, std::uint64_t pattern) noexcept
{
    if (tick % division != 0)
    {
        subVoice.start (subdivisionHz, subdivisionGain, clickSamples, sampleRate);
        return;
    }

    switch (levelAt (pattern, tick / division))
    {
        case BeatLevel::off:                                                                          break;
        case BeatLevel::soft:   beatVoice.start (beatHz,   softGain,   clickSamples, sampleRate);      break;
        case BeatLevel::normal: beatVoice.start (beatHz,   normalGain, clickSamples, sampleRate);      break;
        case BeatLevel::accent: beatVoice.start (accentHz, accentGain, clickSamples, sampleRate);      break;
    }
}

void MetronomeProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const auto command = (Command) pendingCommand.exchange (0, std::memory_order_acq_rel);
    const bool nowEnabled = enabled.load (std::memory_order_relaxed);

    // A sync, or switching on, restarts the bar. The enabled edge is tracked
    // here rather than in the setter so the reset lands on the audio thread's
    // own timeline — the message thread must not touch the counter.
    if (command == Command::sync || (nowEnabled && ! wasEnabled))
        resetBar();
    wasEnabled = nowEnabled;

    if (! nowEnabled || sampleRate <= 0.0)
    {
        // Cut the voices rather than letting them ring out: stopping the
        // metronome should be silent immediately, and the input has already
        // passed through untouched.
        beatVoice.reset();
        subVoice.reset();
        publishedRunning.store (false, std::memory_order_relaxed);
        publishedBeat.store (0, std::memory_order_relaxed);
        publishedBeatPhase.store (0.0f, std::memory_order_relaxed);
        return;
    }

    const int beats = beatsPerBar.load (std::memory_order_relaxed);
    const int division = subdivision.load (std::memory_order_relaxed);
    const int ticksPerBar = beats * division;
    const auto pattern = beatPattern.load (std::memory_order_relaxed);
    const float level = levelGain.load (std::memory_order_relaxed);

    // Recomputed per block, not per sample. The countdown is deliberately
    // left alone: a live tempo change keeps the phase it was at, so the click
    // neither doubles nor skips at the moment the knob moves.
    samplesPerTick = sampleRate * 60.0 / (double) bpm.load (std::memory_order_relaxed) / (double) division;

    // Shrinking the bar or coarsening the subdivision can strand the counters
    // past the end of the new bar, and a longer subdivision leaves a countdown
    // longer than a tick — both would publish a phase outside 0..1.
    if (tickIndex >= ticksPerBar) tickIndex = 0;
    if (currentTick >= ticksPerBar) currentTick = 0;
    samplesToNextTick = juce::jmin (samplesToNextTick, samplesPerTick);

    const int numSamples = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    auto* left = numChannels > 0 ? buffer.getWritePointer (0) : nullptr;
    auto* right = numChannels > 1 ? buffer.getWritePointer (1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        if (samplesToNextTick <= 0.0)
        {
            fireTick (tickIndex, division, pattern);
            currentTick = tickIndex;
            tickIndex = (tickIndex + 1) % ticksPerBar;
            samplesToNextTick += samplesPerTick;
        }

        const float click = (beatVoice.next() + subVoice.next()) * level;
        if (left != nullptr) left[i] += click;
        if (right != nullptr) right[i] += click;
        samplesToNextTick -= 1.0;
    }

    // Phase spans the whole beat, not the tick, so the UI's beat indicator
    // sweeps evenly whatever the subdivision is.
    const double tickFraction = samplesPerTick > 0.0
        ? juce::jlimit (0.0, 1.0, 1.0 - samplesToNextTick / samplesPerTick)
        : 0.0;
    const double phase = ((currentTick % division) + tickFraction) / (double) division;

    publishedRunning.store (true, std::memory_order_relaxed);
    publishedBeat.store (currentTick / division, std::memory_order_relaxed);
    publishedBeatPhase.store (juce::jlimit (0.0f, std::nextafter (1.0f, 0.0f), (float) phase),
                              std::memory_order_relaxed);
}
