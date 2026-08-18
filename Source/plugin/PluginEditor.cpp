#include "PluginEditor.h"
#include "AppPaths.h"

PlectrifyAudioProcessorEditor::PlectrifyAudioProcessorEditor (PlectrifyAudioProcessor& processorToUse)
    : juce::AudioProcessorEditor (processorToUse), processor (processorToUse)
{
    auto& engine = processor.getEngine();

    // Its own WebView2 profile, never the standalone's: the two run in
    // separate processes, and a shared user-data folder is a profile-lock
    // conflict the moment both are open.
    const auto options = engine.registerEventListeners (
        plectrify::makeEngineWebViewOptions (plectrify::appDataDir().getChildFile ("WebView2-Plugin")));

    webView = std::make_unique<plectrify::AmpWebBrowserComponent> (options);
    addAndMakeVisible (*webView);
    engine.attachWebView (webView.get());

    setResizable (true, true);
    setResizeLimits (760, 480, 32768, 32768);
    setSize (engine.editorWidth, engine.editorHeight);
}

PlectrifyAudioProcessorEditor::~PlectrifyAudioProcessorEditor()
{
    // Before the view dies: the engine outlives every editor and must not
    // push events into a destroyed component.
    processor.getEngine().detachWebView();
}

void PlectrifyAudioProcessorEditor::resized()
{
    if (webView != nullptr)
        webView->setBounds (getLocalBounds());

    // Remembered on the engine so the next open comes back at this size; the
    // editor itself will not live to see it.
    auto& engine = processor.getEngine();
    if (engine.editorWidth == getWidth() && engine.editorHeight == getHeight())
        return;

    engine.editorWidth  = getWidth();
    engine.editorHeight = getHeight();

    // Only on a real change: the page's grip streams a resize per animation
    // frame, and every one of these lands in the host.
    processor.editorSizeChanged();
}

void PlectrifyAudioProcessorEditor::parentHierarchyChanged()
{
    if (navigationScheduled || webView == nullptr || getPeer() == nullptr)
        return;

    navigationScheduled = true;

    // The same deferral as the standalone shell: WebView2 initialises
    // asynchronously once a real window peer exists, and navigating before its
    // resource filter is registered aborts the load.
    juce::Component::SafePointer<PlectrifyAudioProcessorEditor> safe (this);
    juce::Timer::callAfterDelay (500, [safe]
    {
        if (safe != nullptr && safe->webView != nullptr)
            safe->webView->goToURL (plectrify::uiNavigationTarget());
    });
}
