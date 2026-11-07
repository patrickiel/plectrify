#include <JuceHeader.h>

#include "UpdateManifest.h"

#include <iostream>

/*
    The rules behind installing an update from inside the app. Everything here
    authorises either a download or an elevated process, so each is pinned
    against the manifest shape scripts/release.windows.ts actually writes and
    against the ways a manifest could be wrong.
*/

namespace
{
    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    void expectEquals (const juce::String& actual, const juce::String& expected, const char* what)
    {
        if (actual != expected)
        {
            ++failures;
            std::cerr << "FAIL " << what << " — got \"" << actual << "\", expected \""
                      << expected << "\"\n";
        }
    }

    using namespace plectrify::update;

    const juce::String goodHash = "baae25392e5299b49e50b812ac67561a356ae94ab6e1829b705194570ef30dc2";

    juce::var manifestWith (const juce::String& version, const juce::String& platform,
                            const juce::String& installer, const juce::String& sha256)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("product", "Plectrify");
        object->setProperty ("version", version);
        object->setProperty ("platform", platform);
        object->setProperty ("installer", installer);
        object->setProperty ("sha256", sha256);
        object->setProperty ("signed", false);
        return juce::var (object);
    }

    void testVersions()
    {
        expect (parseVersion ("0.1.8").has_value(), "MAJOR.MINOR.PATCH parses");
        expect (parseVersion ("v0.1.8").has_value(), "a leading v (the release tags) parses");
        expect (! parseVersion ("dev").has_value(), "the mock's 'dev' does not parse");
        expect (! parseVersion ("0.2.0-rc1").has_value(), "a pre-release suffix does not parse");
        expect (! parseVersion ("0.1").has_value(), "two parts do not parse");
        expect (! parseVersion ("").has_value(), "the empty string does not parse");

        expect (isNewerVersion ("0.1.9", "0.1.8"), "a later patch is newer");
        expect (isNewerVersion ("0.10.0", "0.9.0"), "compared numerically, not as strings");
        expect (! isNewerVersion ("0.1.8", "0.1.8"), "the same version is not newer");
        expect (! isNewerVersion ("0.1.7", "0.1.8"), "an older version is not newer");
        expect (! isNewerVersion ("0.1.9", "dev"), "nothing is newer than a version that cannot be compared");
    }

    void testInstallerNames()
    {
        expect (isPlausibleInstallerName ("Plectrify-win-x64-setup.exe"), "the shipped name passes");
        expect (! isPlausibleInstallerName ("setup"), "no .exe suffix is refused");
        expect (! isPlausibleInstallerName ("..\\evil.exe"), "a parent-directory hop is refused");
        expect (! isPlausibleInstallerName ("sub/evil.exe"), "a path separator is refused");
        expect (! isPlausibleInstallerName (".hidden.exe"), "a leading dot is refused");
        expect (! isPlausibleInstallerName ("with space.exe"), "a space is refused");
        expect (! isPlausibleInstallerName (""), "an empty name is refused");
    }

    void testManifest()
    {
        const auto good = parseReleaseManifest (
            manifestWith ("0.1.8", "windows-x64", "Plectrify-win-x64-setup.exe", goodHash.toUpperCase()));
        expect (good.has_value(), "the release pipeline's own manifest is accepted");

        if (good)
        {
            expectEquals (good->version, "0.1.8", "the version is read");
            expectEquals (good->installer, "Plectrify-win-x64-setup.exe", "the installer name is read");
            expectEquals (good->sha256, goodHash, "the hash is lower-cased, as juce::SHA256 prints it");
        }

        expect (! parseReleaseManifest (manifestWith ("0.1.8", "macos-arm64", "Plectrify.exe", goodHash)).has_value(),
                "another platform's manifest is refused");
        expect (! parseReleaseManifest (manifestWith ("v0.1.8", "windows-x64", "Plectrify.exe", goodHash)).has_value(),
                "the manifest's version carries no v");
        expect (! parseReleaseManifest (manifestWith ("nightly", "windows-x64", "Plectrify.exe", goodHash)).has_value(),
                "an unparseable version is refused");
        expect (! parseReleaseManifest (manifestWith ("0.1.8", "windows-x64", "../Plectrify.exe", goodHash)).has_value(),
                "an installer name that is a path is refused");
        expect (! parseReleaseManifest (manifestWith ("0.1.8", "windows-x64", "Plectrify.exe", "abc")).has_value(),
                "a short hash is refused");
        expect (! parseReleaseManifest (manifestWith ("0.1.8", "windows-x64", "Plectrify.exe",
                                                      "zz" + goodHash.substring (2))).has_value(),
                "a non-hex hash is refused");
        expect (! parseReleaseManifest (juce::var ("not an object")).has_value(), "a non-object is refused");
        expect (! parseReleaseManifest (juce::var()).has_value(), "void is refused");
    }

    void testUrlsAndArguments()
    {
        expectEquals (latestAssetUrl ("release-manifest.json"),
                      "https://github.com/patrickiel/plectrify/releases/latest/download/release-manifest.json",
                      "assets come from the newest promoted release");

        const auto args = installerArguments (juce::File::getCurrentWorkingDirectory().getChildFile ("install.log"));
        expect (args.contains ("/SILENT"), "silent, with the progress window");
        expect (! args.contains ("/VERYSILENT"), "but not very silent");
        expect (args.contains ("/NOCLOSEAPPLICATIONS"), "Setup never closes another program");
        expect (! args.contains ("/SUPPRESSMSGBOXES"), "an error is shown, not answered with Abort");
        expect (args.contains ("/PLECTRIFYRELAUNCH=1"), "the installer is told the app launched it");
        expect (args.contains ("/LOG=\""), "the log path is quoted (it can contain spaces)");
    }
}

int main()
{
    testVersions();
    testInstallerNames();
    testManifest();
    testUrlsAndArguments();

    if (failures == 0)
        std::cout << "UpdateManifest tests passed\n";

    return failures;
}
