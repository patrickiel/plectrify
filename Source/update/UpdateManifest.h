#pragma once

#include <JuceHeader.h>

#include <array>
#include <optional>

/**
    The pure rules behind installing a Plectrify update from inside the app.

    Nothing here touches the network, the disk or a process: these functions
    read a release manifest, compare versions and build the two URLs and the
    installer's command line, so every decision that authorises a download or
    an elevated process can be pinned in Plectrify.UpdateManifest (ctest) with
    no release server in the loop. UpdateInstaller is what acts on them.

    The manifest is the `release-manifest.json` scripts/release.windows.ts
    uploads beside the installer: one JSON object naming the version, the
    platform slug, the installer's file name and its SHA-256. Both it and the
    installer are fetched from `/releases/latest/download/`, the same prefix
    the site's download buttons use, so promoting a release (RELEASING.md) is
    what moves the in-app update too — never a pre-release.
*/
namespace plectrify::update
{

/** The repository every URL here points into. */
constexpr const char* repositorySlug = "patrickiel/plectrify";

/** The platform slug the Windows manifest records; any other is refused. */
constexpr const char* windowsPlatform = "windows-x64";

/** The Windows manifest carries no platform suffix (the mac and Linux jobs
    write release-manifest-macos.json / -linux.json beside it). */
constexpr const char* manifestFileName = "release-manifest.json";

/** What the manifest says about the release it describes. */
struct ReleaseManifest
{
    juce::String version;     ///< MAJOR.MINOR.PATCH, no leading `v`
    juce::String installer;   ///< a bare file name ending in .exe
    juce::String sha256;      ///< 64 lower-case hex characters
};

/** The three numeric parts of `MAJOR.MINOR.PATCH` (an optional leading `v`
    is accepted, since the release tags carry one), or nothing for anything
    else. Strict on purpose, and the twin of parseVersion in
    ui/src/features/info/updateCheck.ts: what cannot be compared is not news. */
std::optional<std::array<int, 3>> parseVersion (const juce::String& value);

/** True only when both sides parse and `candidate` is strictly newer than
    `current`, compared part by part. */
bool isNewerVersion (const juce::String& candidate, const juce::String& current);

/** True for a name that can only ever be a file beside its parent — letters,
    digits, `.`, `_` and `-`, ending in `.exe`, no separators and no leading
    dot. The manifest arrives over the network and this name becomes a path
    the app writes to, so anything else is refused outright. */
bool isPlausibleInstallerName (const juce::String& name);

/** Reads a parsed manifest document. Nothing is returned unless the platform
    is windowsPlatform, the version parses, the installer name passes
    isPlausibleInstallerName and the hash is 64 hex characters (returned
    lower-cased, which is how juce::SHA256 prints). */
std::optional<ReleaseManifest> parseReleaseManifest (const juce::var& document);

/** `https://github.com/<repo>/releases/latest/download/<name>` — the asset
    of the newest promoted release, for the manifest and the installer alike.
    Built from the validated name, never taken from the manifest itself. */
juce::String latestAssetUrl (const juce::String& assetName);

/** The arguments the installer is started with when the app runs it.

    `/SILENT` rather than `/VERYSILENT`: no wizard pages, but the progress
    window stays, and it is the one thing on screen between this app closing
    and the new one opening. `/NORESTART` because the Visual C++ redistributable
    may ask for one. `/NOCANCEL` because a half-replaced installation is worse
    than a finished one. `/NOCLOSEAPPLICATIONS` so Setup never closes another
    program on the user's behalf — in silent mode Restart Manager would do so
    without asking, and the program would be their DAW. No `/SUPPRESSMSGBOXES`:
    it answers a file-in-use box with Abort, leaving no app on screen and no
    word why. `/PLECTRIFYRELAUNCH=1` is what packaging/windows/Plectrify.iss
    reads to wait for this process and relaunch the new one; `/LOG` names a
    file beside the download for when something goes wrong anyway. */
juce::String installerArguments (const juce::File& logFile);

} // namespace plectrify::update
