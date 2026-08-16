#include <JuceHeader.h>

#include "TunerDetector.h"

#include <cmath>
#include <iostream>
#include <memory>
#include <vector>

namespace
{
constexpr double pi = 3.14159265358979323846;

std::vector<float> makeTone (double sampleRate, float frequency, double seconds,
                             bool weakFundamental = false)
{
    const auto count = juce::roundToInt (sampleRate * seconds);
    std::vector<float> result ((size_t) count);
    double phase = 0.0;
    const auto phaseStep = 2.0 * pi * frequency / sampleRate;
    std::uint32_t noiseState = 0x12345678u;

    for (auto& sample : result)
    {
        const auto fundamental = (weakFundamental ? 0.10 : 0.55) * std::sin (phase);
        const auto second = (weakFundamental ? 0.55 : 0.22) * std::sin (2.0 * phase + 0.13);
        const auto third = (weakFundamental ? 0.28 : 0.10) * std::sin (3.0 * phase + 0.31);
        noiseState = noiseState * 1664525u + 1013904223u;
        const auto noise = ((float) (noiseState >> 8) / 8388607.5f - 1.0f) * 0.003f;
        sample = (float) (0.45 * (fundamental + second + third))
            + (weakFundamental ? 0.015f + noise : 0.0f);
        phase += phaseStep;
    }

    return result;
}

// Detectors live on the heap throughout these tests: the analysis buffers
// (the FIFO above all) sum to a few hundred KB, which two stack instances
// would overflow MSVC's default 1 MB stack with.
TunerReading detect (double sampleRate, float frequency, bool weakFundamental)
{
    auto detector = std::make_unique<TunerDetector>();
    detector->prepare (sampleRate);
    const auto samples = makeTone (sampleRate, frequency, 0.34, weakFundamental);

    for (size_t offset = 0; offset < samples.size(); offset += 256)
    {
        const auto count = (int) juce::jmin ((size_t) 256, samples.size() - offset);
        detector->pushSamples (samples.data() + offset, count);
    }

    juce::Thread::sleep (350);
    const auto reading = detector->getReading();
    detector->release();
    return reading;
}

void pushInBlocks (TunerDetector& detector, const std::vector<float>& samples)
{
    for (size_t offset = 0; offset < samples.size(); offset += 256)
    {
        const auto count = (int) juce::jmin ((size_t) 256, samples.size() - offset);
        detector.pushSamples (samples.data() + offset, count);
    }
}

float absoluteCentsError (float actual, float expected)
{
    return std::abs (1200.0f * std::log2 (actual / expected));
}
}

int main()
{
    struct TestTone { float frequency; bool weakFundamental; };
    const TestTone tones[] {
        { 30.868f, false }, // five-string bass low B
        { 41.203f, true },  // bass low E with stronger harmonics
        { 82.407f, true },  // guitar low E with stronger harmonics
        { 440.0f, false },
        { 1318.51f, false }
    };
    const double sampleRates[] { 44100.0, 48000.0, 96000.0, 192000.0 };

    int failures = 0;
    for (const auto sampleRate : sampleRates)
    {
        for (const auto tone : tones)
        {
            const auto reading = detect (sampleRate, tone.frequency, tone.weakFundamental);
            const auto error = reading.detected
                ? absoluteCentsError (reading.frequencyHz, tone.frequency)
                : 1000.0f;

            if (! reading.detected || error > 1.0f)
            {
                ++failures;
                std::cerr << "FAIL " << sampleRate << " Hz input, " << tone.frequency
                          << " Hz tone: detected=" << reading.detected
                          << ", result=" << reading.frequencyHz
                          << ", error=" << error << " cents\n";
            }
        }
    }

    {
        auto detector = std::make_unique<TunerDetector>();
        detector->prepare (48000.0);
        pushInBlocks (*detector, makeTone (48000.0, 82.407f, 0.34, true));
        juce::Thread::sleep (250);
        pushInBlocks (*detector, makeTone (48000.0, 110.0f, 0.34, true));
        juce::Thread::sleep (250);

        const auto transitioned = detector->getReading();
        if (! transitioned.detected || absoluteCentsError (transitioned.frequencyHz, 110.0f) > 1.0f)
        {
            ++failures;
            std::cerr << "FAIL note transition did not settle on A2\n";
        }

        std::vector<float> silence ((size_t) juce::roundToInt (48000.0 * 0.30), 0.0f);
        pushInBlocks (*detector, silence);
        juce::Thread::sleep (250);
        if (detector->getReading().detected)
        {
            ++failures;
            std::cerr << "FAIL stale reading survived silence\n";
        }

        detector->setEnabled (false);
        if (detector->getReading().detected)
        {
            ++failures;
            std::cerr << "FAIL disabling did not clear the reading\n";
        }
        detector->release();
    }

    if (failures != 0)
        return 1;

    std::cout << "TunerDetector: all synthetic pitch cases passed\n";
    return 0;
}
