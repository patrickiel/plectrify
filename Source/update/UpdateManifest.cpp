#include "UpdateManifest.h"

namespace plectrify::update
{

std::optional<std::array<int, 3>> parseVersion (const juce::String& value)
{
    auto text = value.trim();

    if (text.startsWithIgnoreCase ("v"))
        text = text.substring (1);

    juce::StringArray parts;
    parts.addTokens (text, ".", {});

    if (parts.size() != 3)
        return std::nullopt;

    std::array<int, 3> result {};

    for (int i = 0; i < 3; ++i)
    {
        const auto& part = parts[i];

        if (part.isEmpty() || ! part.containsOnly ("0123456789"))
            return std::nullopt;

        result[(size_t) i] = part.getIntValue();
    }

    return result;
}

bool isNewerVersion (const juce::String& candidate, const juce::String& current)
{
    const auto a = parseVersion (candidate);
    const auto b = parseVersion (current);

    if (! a || ! b)
        return false;

    for (size_t i = 0; i < 3; ++i)
        if ((*a)[i] != (*b)[i])
            return (*a)[i] > (*b)[i];

    return false;
}

bool isPlausibleInstallerName (const juce::String& name)
{
    if (name.isEmpty() || name.length() > 128)
        return false;

    if (! name.endsWithIgnoreCase (".exe") || name.startsWithChar ('.'))
        return false;

    static const juce::String allowed ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-");
    return name.containsOnly (allowed);
}

std::optional<ReleaseManifest> parseReleaseManifest (const juce::var& document)
{
    if (! document.isObject())
        return std::nullopt;

    if (document["platform"].toString() != windowsPlatform)
        return std::nullopt;

    ReleaseManifest manifest;
    manifest.version   = document["version"].toString().trim();
    manifest.installer = document["installer"].toString().trim();
    manifest.sha256    = document["sha256"].toString().trim().toLowerCase();

    if (! parseVersion (manifest.version) || manifest.version.startsWithIgnoreCase ("v"))
        return std::nullopt;

    if (! isPlausibleInstallerName (manifest.installer))
        return std::nullopt;

    if (manifest.sha256.length() != 64 || ! manifest.sha256.containsOnly ("0123456789abcdef"))
        return std::nullopt;

    return manifest;
}

juce::String latestAssetUrl (const juce::String& assetName)
{
   #if JUCE_DEBUG
    // A Debug build can be pointed at a directory of one's own — a local
    // server holding a hand-written release-manifest.json beside an installer
    // built from the working tree — which is the only way to exercise the
    // whole run, handshake included, against a build that has not shipped.
    // Compile-time gated like PLECTRIFY_CATALOGUE_FILE: a shipped binary has
    // no such override, so nothing can redirect its downloads.
    const auto override = juce::SystemStats::getEnvironmentVariable ("PLECTRIFY_UPDATE_BASE_URL", {});

    if (override.isNotEmpty())
        return override.endsWithChar ('/') ? override + assetName : override + "/" + assetName;
   #endif

    return "https://github.com/" + juce::String (repositorySlug) + "/releases/latest/download/" + assetName;
}

juce::String installerArguments (const juce::File& logFile)
{
    return "/SILENT /NORESTART /NOCANCEL /NOCLOSEAPPLICATIONS /PLECTRIFYRELAUNCH=1 /LOG=\""
           + logFile.getFullPathName() + "\"";
}

} // namespace plectrify::update
