#pragma once

#include <JuceHeader.h>

#include <atomic>

/**
    Base for Plectrify's fixed utility processors (input router, output level,
    lane mixers): a stereo-in/stereo-out pass-through with every piece of
    AudioProcessor boilerplate stubbed out, so a subclass only implements
    processBlock (and prepareToPlay/releaseResources when it needs them).
*/
class PassthroughProcessor : public juce::AudioProcessor
{
public:
    explicit PassthroughProcessor (juce::String name)
        : juce::AudioProcessor (BusesProperties()
              .withInput  ("In",  juce::AudioChannelSet::stereo(), true)
              .withOutput ("Out", juce::AudioChannelSet::stereo(), true)),
          processorName (std::move (name)) {}

    const juce::String getName() const override { return processorName; }

    bool isBusesLayoutSupported (const BusesLayout& layout) const override
    {
        return layout.getMainInputChannelSet() == juce::AudioChannelSet::stereo()
            && layout.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    void prepareToPlay (double, int) override          {}
    void releaseResources() override                   {}
    double getTailLengthSeconds() const override       { return 0.0; }
    bool acceptsMidi() const override                  { return false; }
    bool producesMidi() const override                 { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override                    { return false; }
    int getNumPrograms() override                      { return 1; }
    int getCurrentProgram() override                   { return 0; }
    void setCurrentProgram (int) override              {}
    const juce::String getProgramName (int) override   { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override {}
    void setStateInformation (const void*, int) override   {}

private:
    juce::String processorName;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PassthroughProcessor)
};

/** Lock-free running peak for a UI meter: the audio thread raises it, the
    message thread consumes-and-resets it once per poll. */
class PeakMeter
{
public:
    /** Audio thread. Keeps the maximum seen since the last consume(). */
    void update (float value) noexcept
    {
        auto current = peak.load (std::memory_order_relaxed);
        while (value > current
               && ! peak.compare_exchange_weak (current, value, std::memory_order_relaxed)) {}
    }

    /** Message thread. Returns the peak and resets it. */
    float consume() noexcept { return peak.exchange (0.0f); }

private:
    std::atomic<float> peak { 0.0f };
};
