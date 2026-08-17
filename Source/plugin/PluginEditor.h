#pragma once

#include <JuceHeader.h>
#include "EngineWebView.h"
#include "PluginProcessor.h"

#include <memory>

/**
    The plugin's editor: nothing but the shared web view, attached to the
    processor's engine for the editor's lifetime. DAWs create and destroy this
    freely while audio keeps running; the page reloads on every open, which is
    exactly why everything the page needs lives in the engine (or on disk)
    rather than in the view.
*/
class PlectrifyAudioProcessorEditor : public juce::AudioProcessorEditor
{
public:
    explicit PlectrifyAudioProcessorEditor (PlectrifyAudioProcessor& processorToUse);
    ~PlectrifyAudioProcessorEditor() override;

    void resized() override;
    void parentHierarchyChanged() override; // navigate once we have a window peer

private:
    PlectrifyAudioProcessor& processor;
    std::unique_ptr<plectrify::AmpWebBrowserComponent> webView;
    bool navigationScheduled = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PlectrifyAudioProcessorEditor)
};
