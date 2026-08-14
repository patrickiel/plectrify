#pragma once

#include <JuceHeader.h>

/**
    A resizable window that hosts a hosted plugin's own editor (or a generic
    parameter panel if the plugin provides no custom UI or its editor fails to
    create). Closing the window notifies its owner exactly once; the owner must
    defer destruction until after closeButtonPressed() has returned.
*/
class PluginEditorWindow : public juce::DocumentWindow
{
public:
    PluginEditorWindow (juce::AudioPluginInstance& plugin, std::function<void()> onCloseCallback);
    ~PluginEditorWindow() override;

    void closeButtonPressed() override;

private:
    std::function<void()> onClose;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginEditorWindow)
};
