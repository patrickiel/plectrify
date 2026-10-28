#pragma once

#include <JuceHeader.h>

#include "NamPluginProcessor.h"

/**
    The Linux Neural Amp Modeler's own window: two file slots (the capture and
    the cabinet IR) above JUCE's generic parameter editor.

    Deliberately plain. Inside Plectrify the six knobs live on the module card and
    a TONE3000 pick loads the capture without this window ever opening; what this
    is for is the rest — choosing a capture by hand, the IR, the noise gate and
    calibration switches — which upstream's iPlug2 editor offers and a host's
    generic view would leave without a way to pick a file.

    Message thread only. Polls the processor's paths on a timer, since a host or
    Plectrify can load a new state while the window is open.
*/
class NamPluginEditor final : public juce::AudioProcessorEditor,
                              private juce::Timer
{
public:
    explicit NamPluginEditor (NamPluginProcessor&);
    ~NamPluginEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    /** One file slot: what is loaded, a button to choose another, one to clear. */
    struct FileSlot
    {
        juce::Label title, file;
        juce::TextButton choose { "Load..." }, clear { "Clear" };
    };

    void timerCallback() override;
    void setUpSlot (FileSlot&, const juce::String& title, const juce::String& pattern, bool isModel);
    void showSlot (FileSlot&, const juce::String& path);

    NamPluginProcessor& processor;
    FileSlot modelSlot, irSlot;
    juce::Label status;
    juce::GenericAudioProcessorEditor parameters;
    std::unique_ptr<juce::FileChooser> chooser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NamPluginEditor)
};
