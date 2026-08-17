#pragma once

#include <JuceHeader.h>

#include <optional>

/**
    The engine's web view, shared by the standalone shell and the VST3 plugin
    editor: the component subclass that keeps the surface dark during native
    resizes, the resource provider that serves the built Svelte app, and the
    options boilerplate both hosts build their view from.

    Only the WebView2 user-data folder differs per host — the app and the
    plugin run in separate processes and must never share a profile lock, so
    each names its own folder under the per-user data root.
*/
namespace plectrify
{
    /** The page's own background, painted behind WebView2 while its native
        child window catches up with a live resize. */
    juce::Colour appBackgroundColour();

    /** Keeps JUCE's component surface dark while WebView2's native child window
        catches up with a live resize. WebBrowserComponent's default fallback
        paint is hardcoded white. */
    class AmpWebBrowserComponent final : public juce::WebBrowserComponent
    {
    public:
        using juce::WebBrowserComponent::WebBrowserComponent;

        void paint (juce::Graphics& graphics) override
        {
            juce::WebBrowserComponent::paint (graphics);
            graphics.fillAll (appBackgroundColour());
        }
    };

    /** Serves the built Svelte app from the staged ui directory under
        moduleResourceDir() — beside the exe on Windows, Contents/Resources
        inside the bundle on macOS, the .vst3 bundle's own Resources in a
        plugin build. Debug builds fall back to the source tree's ui/dist
        (PLECTRIFY_UI_DIST_DIR) so the dev workflow needs no copying. */
    std::optional<juce::WebBrowserComponent::Resource> provideUiResource (const juce::String& path);

    /** Where the web view first navigates. Normally the resource-provider
        root, which serves ui/dist through provideUiResource(). In Debug, if
        PLECTRIFY_DEV_URL is set (the run scripts point it at Vite's dev
        server), that instead: the native bridge stays live while the UI
        hot-reloads. Release builds ignore the env var. */
    juce::String uiNavigationTarget();

    /** The web-view options both hosts share: backend selection, the WebView2
        profile/background on Windows, native integration and the resource
        provider. The caller chains its withEventListener registrations onto
        the returned value (see PlectrifyEngine::registerEventListeners) before
        constructing the component. Creates `userDataFolder` if needed; the
        parameter is unused on macOS, where WKWebView has no runtime profile to
        place. */
    juce::WebBrowserComponent::Options makeEngineWebViewOptions (const juce::File& userDataFolder);
}
