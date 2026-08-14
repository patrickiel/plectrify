#include <JuceHeader.h>

#include "MetronomeProcessor.h"

#include <cmath>
#include <iostream>
#include <vector>

/*
    Headless coverage for the metronome's sample clock and synthesized audio.
    Calls interleave settings and blocks exactly as the host does; no device,
    graph or message loop is involved.
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

    juce::AudioBuffer<float> process (MetronomeProcessor& metronome, int samples,
                                      float input = 0.0f)
    {
        juce::AudioBuffer<float> buffer (2, samples);
        for (int channel = 0; channel < 2; ++channel)
            juce::FloatVectorOperations::fill (buffer.getWritePointer (channel), input, samples);
        juce::MidiBuffer midi;
        metronome.processBlock (buffer, midi);
        return buffer;
    }

    float peakIn (const juce::AudioBuffer<float>& buffer, int start, int length)
    {
        return buffer.getMagnitude (0, start, juce::jmin (length, buffer.getNumSamples() - start));
    }

    std::vector<int> clickOnsets (const juce::AudioBuffer<float>& buffer, float threshold = 1.0e-5f)
    {
        std::vector<int> result;
        int silent = 0;
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            const bool nonZero = std::abs (buffer.getSample (0, i)) > threshold;
            if (nonZero && (result.empty() || silent > 8))
                result.push_back (i);
            silent = nonZero ? 0 : silent + 1;
        }
        return result;
    }
}

static void testDisabledIsTransparent()
{
    MetronomeProcessor metronome;
    metronome.prepareToPlay (rate, blockSize);
    auto buffer = process (metronome, blockSize, 0.25f);
    bool unchanged = true;
    for (int channel = 0; channel < 2; ++channel)
        for (int sample = 0; sample < blockSize; ++sample)
            unchanged = unchanged && buffer.getSample (channel, sample) == 0.25f;
    expect (unchanged, "disabled metronome is bit-identical passthrough");
}

static void testEnableAndTempoSpacing()
{
    for (const float bpm : { 40.0f, 120.0f, 240.0f })
    {
        MetronomeProcessor metronome;
        metronome.prepareToPlay (rate, blockSize);
        metronome.setBpm (bpm);
        metronome.setBeatsPerBar (MetronomeProcessor::maxBeatsPerBar);
        metronome.setEnabled (true);

        const int spacing = (int) std::lround (rate * 60.0 / bpm);
        auto buffer = process (metronome, spacing * 17 + 2048);
        const auto onsets = clickOnsets (buffer);
        expect (onsets.size() >= 17, "tempo emits at least seventeen beat onsets");
        if (onsets.size() >= 17)
        {
            expect (onsets.front() <= 2, "enabling fires the downbeat immediately");
            bool spaced = true;
            for (int i = 1; i < 17; ++i)
                spaced = spaced && std::abs ((onsets[(size_t) i] - onsets[(size_t) i - 1]) - spacing) <= 1;
            expect (spaced, "beat spacing follows BPM within one sample");
        }
        expect (metronome.getStatus().running, "enabled metronome publishes running");
    }
}

static void testSubdivisionsKeepBeatsPut()
{
    constexpr float bpm = 240.0f;
    const int beatSpacing = (int) std::lround (rate * 60.0 / bpm);
    for (int division = 2; division <= MetronomeProcessor::maxSubdivision; ++division)
    {
        MetronomeProcessor metronome;
        metronome.prepareToPlay (rate, blockSize);
        metronome.setBpm (bpm);
        metronome.setBeatsPerBar (4);
        metronome.setSubdivision (division);
        metronome.setEnabled (true);
        auto buffer = process (metronome, beatSpacing * 2);

        const int tickSpacing = (int) std::lround ((double) beatSpacing / division);
        bool allTicksSound = true;
        for (int tick = 0; tick < division * 2; ++tick)
        {
            const int expected = (int) std::lround ((double) tick * beatSpacing / division);
            allTicksSound = allTicksSound && peakIn (buffer, juce::jmax (0, expected),
                                                     juce::jmax (2, tickSpacing / 2)) > 0.001f;
        }
        expect (allTicksSound, "each subdivision tick sounds between beats");
        expect (peakIn (buffer, beatSpacing, juce::jmax (2, tickSpacing / 2))
                    > peakIn (buffer, tickSpacing, juce::jmax (2, tickSpacing / 2)),
                "beat stays on the original pulse and is louder than subdivisions");
    }
}

static float firstClickPeak (MetronomeProcessor::BeatLevel level, float levelDb = 0.0f)
{
    MetronomeProcessor metronome;
    metronome.prepareToPlay (rate, blockSize);
    metronome.setLevelDb (levelDb);
    metronome.setBeatPattern (MetronomeProcessor::packLevel (
        MetronomeProcessor::defaultPattern(), 0, level));
    metronome.setEnabled (true);
    auto buffer = process (metronome, 2048);
    return peakIn (buffer, 0, buffer.getNumSamples());
}

static void testAccentPatternAndLevel()
{
    const auto off = firstClickPeak (MetronomeProcessor::BeatLevel::off);
    const auto soft = firstClickPeak (MetronomeProcessor::BeatLevel::soft);
    const auto normal = firstClickPeak (MetronomeProcessor::BeatLevel::normal);
    const auto accent = firstClickPeak (MetronomeProcessor::BeatLevel::accent);
    expect (off == 0.0f && soft > off && normal > soft && accent > normal,
            "beat levels order off, soft, normal, accent");

    const auto minusTwelve = firstClickPeak (MetronomeProcessor::BeatLevel::accent, -12.0f);
    expect (near (minusTwelve / accent, juce::Decibels::decibelsToGain (-12.0f), 0.002f),
            "output level scales clicks in decibels");
}

static void testCommandsStatusAndClamping()
{
    MetronomeProcessor metronome;
    metronome.prepareToPlay (rate, blockSize);
    metronome.setBpm (-100.0f);
    metronome.setBeatsPerBar (99);
    metronome.setSubdivision (0);
    metronome.setLevelDb (12.0f);
    expect (metronome.getBpm() == MetronomeProcessor::minBpm,
            "BPM setter clamps to minimum");
    expect (metronome.getBeatsPerBar() == MetronomeProcessor::maxBeatsPerBar,
            "beats setter clamps to maximum");
    expect (metronome.getSubdivision() == 1, "subdivision setter clamps to minimum");
    metronome.setSubdivision (99);
    expect (metronome.getSubdivision() == MetronomeProcessor::maxSubdivision,
            "subdivision setter clamps to maximum");
    expect (metronome.getLevelDb() == MetronomeProcessor::maxLevelDb,
            "level setter clamps to maximum");

    metronome.setBpm (120.0f);
    metronome.setBeatsPerBar (4);
    metronome.setEnabled (true);
    process (metronome, (int) rate * 2);
    auto before = metronome.getStatus();
    expect (before.beat >= 0 && before.beat < 4 && before.beatPhase >= 0.0f
                && before.beatPhase <= 1.0f,
            "published beat and phase stay in range");

    metronome.postCommand (MetronomeProcessor::Command::sync);
    process (metronome, 1);
    const auto synced = metronome.getStatus();
    expect (synced.beat == 0 && synced.beatPhase < 0.001f, "sync realigns to the downbeat");

    metronome.setEnabled (false);
    auto stopped = process (metronome, blockSize);
    expect (! metronome.getStatus().running && stopped.getMagnitude (0, 0, blockSize) == 0.0f,
            "disabling immediately stops and clears ringing voices");
}

static void testRateChangeAndNonClickPassthrough()
{
    MetronomeProcessor metronome;
    metronome.prepareToPlay (rate, blockSize);
    metronome.setBpm (60.0f);
    metronome.setEnabled (true);
    process (metronome, 2048);

    const double newRate = 44100.0;
    metronome.prepareToPlay (newRate, blockSize);
    auto buffer = process (metronome, (int) newRate + 2048, 0.125f);
    const int clickLength = (int) std::lround (newRate * 0.035);
    bool unchangedBetweenClicks = true;
    for (int i = clickLength + 4; i < (int) newRate - 4; ++i)
        unchangedBetweenClicks = unchangedBetweenClicks && buffer.getSample (0, i) == 0.125f;
    expect (unchangedBetweenClicks, "between clicks the processor is transparent");
    expect (peakIn (buffer, (int) newRate, 1800) > 0.125f,
            "sample-rate change resets and keeps one-second spacing at 60 BPM");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    testDisabledIsTransparent();
    testEnableAndTempoSpacing();
    testSubdivisionsKeepBeatsPut();
    testAccentPatternAndLevel();
    testCommandsStatusAndClamping();
    testRateChangeAndNonClickPassthrough();

    if (failures != 0)
        return 1;

    std::cout << "MetronomeProcessor: all cases passed\n";
    return 0;
}
