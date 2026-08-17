#include "EngineWebView.h"
#include "AppPaths.h"

#include <cstring>

namespace plectrify
{

juce::Colour appBackgroundColour()
{
    return juce::Colour::fromRGB (2, 3, 5);
}

namespace
{
    juce::String mimeForExtension (const juce::String& ext)
    {
        if (ext == ".html") return "text/html";
        if (ext == ".js" || ext == ".mjs") return "text/javascript";
        if (ext == ".css")  return "text/css";
        if (ext == ".json") return "application/json";
        if (ext == ".svg")  return "image/svg+xml";
        if (ext == ".png")  return "image/png";
        if (ext == ".ico")  return "image/x-icon";
        if (ext == ".woff2") return "font/woff2";
        return "application/octet-stream";
    }
}

std::optional<juce::WebBrowserComponent::Resource> provideUiResource (const juce::String& path)
{
    auto dist = moduleResourceDir().getChildFile ("ui");

   #ifdef PLECTRIFY_UI_DIST_DIR
    if (! dist.isDirectory())
        dist = juce::File (PLECTRIFY_UI_DIST_DIR);
   #endif

    const juce::String rel = (path == "/") ? "index.html"
                                           : path.upToFirstOccurrenceOf ("?", false, false)
                                                 .upToFirstOccurrenceOf ("#", false, false)
                                                 .trimCharactersAtStart ("/");
    const juce::File file = dist.getChildFile (rel);

    juce::MemoryBlock mb;
    if (! file.existsAsFile() || ! file.loadFileAsData (mb))
    {
        // Diagnostic page so a miss is visible instead of a blank "can't reach".
        const juce::String html =
            "<html><body style='font-family:sans-serif;background:#111;color:#eee;padding:24px'>"
            "<h2>Plectrify resource not found</h2>"
            "<p>requested path: <code>" + path + "</code></p>"
            "<p>resolved file: <code>" + file.getFullPathName() + "</code></p>"
            "<p>dist dir exists: <code>" + juce::String (dist.isDirectory() ? "yes" : "no") + "</code></p>"
            "<p>index.html exists: <code>"
            + juce::String (dist.getChildFile ("index.html").existsAsFile() ? "yes" : "no") + "</code></p>"
            "</body></html>";
        std::vector<std::byte> bytes (html.getNumBytesAsUTF8());
        std::memcpy (bytes.data(), html.toRawUTF8(), bytes.size());
        return juce::WebBrowserComponent::Resource { std::move (bytes), "text/html" };
    }

    std::vector<std::byte> data (mb.getSize());
    std::memcpy (data.data(), mb.getData(), mb.getSize());

    return juce::WebBrowserComponent::Resource { std::move (data),
                                                 mimeForExtension (file.getFileExtension().toLowerCase()) };
}

juce::String uiNavigationTarget()
{
   #if JUCE_DEBUG
    const auto devUrl = juce::SystemStats::getEnvironmentVariable ("PLECTRIFY_DEV_URL", {}).trim();
    if (devUrl.isNotEmpty())
        return devUrl;
   #endif
    return juce::WebBrowserComponent::getResourceProviderRoot();
}

juce::WebBrowserComponent::Options makeEngineWebViewOptions (const juce::File& userDataFolder)
{
   #if JUCE_WINDOWS
    // Installed builds live under Program Files, which is not a writable
    // WebView2 user-data location for a normal user (and a DAW hosting the
    // plugin build sits somewhere just as read-only). The browser profile
    // lives beside the rest of Plectrify's user data instead.
    userDataFolder.createDirectory();
   #else
    juce::ignoreUnused (userDataFolder);
   #endif

    return juce::WebBrowserComponent::Options{}
       #if JUCE_WINDOWS
        .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
        // WebView2 otherwise exposes its default white backing surface while
        // the web compositor catches up with rapid scrolling or window resizes.
        .withWinWebView2Options (juce::WebBrowserComponent::Options::WinWebView2{}
                                    .withUserDataFolder (userDataFolder)
                                    .withBackgroundColour (appBackgroundColour()))
       #endif
        // macOS takes JUCE's default backend (WKWebView); the white-flash
        // mitigation there is AmpWebBrowserComponent::paint.
        .withNativeIntegrationEnabled()
        .withResourceProvider ([] (const juce::String& path) { return provideUiResource (path); });
}

} // namespace plectrify
