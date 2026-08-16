#pragma once

#include <JuceHeader.h>

#include "PassthroughProcessor.h"

#include <array>
#include <atomic>
#include <cmath>
#include <vector>

/**
    A passive tap on the audio device's own input channels: one peak meter per
    channel, for the setup wizard's "plug in and play" step.

    Deliberately outside the rack graph. The graph only ever carries the one
    channel the guitar is on (see RackProcessor::setInputSourceChannel), and the
    whole point here is to watch the channels it is *not* on — which is what
    turns "which input is your guitar in?" from a question into an observation.
    Registered as a second AudioIODeviceCallback, so it sees exactly the
    channels the device has enabled, in the same order the graph's input node
    numbers them.

    ⚠ AudioDeviceManager sums every callback after the first into the device's
    output, and hands each one an uninitialised scratch buffer. Writing silence
    is therefore an obligation, not an omission: a probe that simply ignored its
    output would add whatever that memory last held to the speakers.

    Metering is gated on an atomic and off by default — the wizard arms it while
    its input step is open and drops it again — so an ordinary session pays for
    one buffer clear per block and nothing else.
*/
class InputProbe final : public juce::AudioIODeviceCallback
{
public:
    /** Metering stops here. Interfaces with more inputs than this are rare, and
        an input past the 64th is not where anyone plugs a guitar in. */
    static constexpr int maxChannels = 64;

    // Spelled out because the non-copyable macro below declares a constructor,
    // which suppresses the implicit one.
    InputProbe() = default;

    /** Message thread. Arming also clears whatever the meters last held, so the
        first reading after the wizard opens describes this moment rather than
        the last one. */
    void setWatching (bool shouldWatch) noexcept
    {
        if (shouldWatch)
            for (auto& meter : peaks)
                meter.consume();

        watching.store (shouldWatch, std::memory_order_relaxed);
    }

    bool isWatching() const noexcept { return watching.load (std::memory_order_relaxed); }

    /** Message thread. Fills `out` with the peak each of the first
        `numChannels` inputs has reached since the last read, and resets them.
        Destructive, like every other meter here: one consumer only. */
    void readPeaks (std::vector<float>& out, int numChannels)
    {
        const auto count = (size_t) juce::jlimit (0, maxChannels, numChannels);
        out.resize (count);
        for (size_t channel = 0; channel < count; ++channel)
            out[channel] = peaks[channel].consume();
    }

    void audioDeviceAboutToStart (juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext&) override
    {
        // Unconditional, and the reason this class can never be a no-op: see
        // the buffer warning above.
        for (int channel = 0; channel < numOutputChannels; ++channel)
            if (outputChannelData[channel] != nullptr)
                juce::FloatVectorOperations::clear (outputChannelData[channel], numSamples);

        if (! watching.load (std::memory_order_relaxed))
            return;

        const auto channels = juce::jmin (numInputChannels, maxChannels);
        for (int channel = 0; channel < channels; ++channel)
        {
            if (const auto* samples = inputChannelData[channel])
            {
                const auto range = juce::FloatVectorOperations::findMinAndMax (samples, numSamples);
                peaks[(size_t) channel].update (juce::jmax (std::abs (range.getStart()),
                                                            std::abs (range.getEnd())));
            }
        }
    }

private:
    std::atomic<bool> watching { false };
    std::array<PeakMeter, (size_t) maxChannels> peaks;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (InputProbe)
};
