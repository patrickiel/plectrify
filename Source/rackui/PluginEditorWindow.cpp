#include "PluginEditorWindow.h"

PluginEditorWindow::PluginEditorWindow (juce::AudioPluginInstance& plugin,
                                        std::function<void()> onCloseCallback)
    : juce::DocumentWindow (plugin.getName(),
                            juce::Colours::darkgrey,
                            juce::DocumentWindow::closeButton),
      onClose (std::move (onCloseCallback))
{
    // Prefer the plugin's own editor; fall back to a generic parameter view.
    // JUCE allows createEditor() to return null even when hasEditor() said
    // true (GPU/resource failure, or a lying plugin), so the fallback also
    // covers that case rather than crashing the host.
    juce::AudioProcessorEditor* editor = plugin.hasEditor()
                                             ? plugin.createEditorAndMakeActive()
                                             : nullptr;
    if (editor == nullptr)
        editor = new juce::GenericAudioProcessorEditor (plugin);

    setUsingNativeTitleBar (true);
    setContentOwned (editor, /*resizeToFit*/ true);
    setResizable (editor->isResizable(), false);
    centreWithSize (getWidth(), getHeight());
    setVisible (true);
}

PluginEditorWindow::~PluginEditorWindow()
{
    clearContentComponent();
}

void PluginEditorWindow::closeButtonPressed()
{
    // The callback ultimately owns this window. Move it out before invoking so
    // repeated close messages cannot schedule duplicate destruction.
    auto callback = std::move (onClose);
    onClose = nullptr;
    if (callback != nullptr)
        callback();
}
