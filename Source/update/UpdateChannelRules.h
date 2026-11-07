#pragma once

#include <JuceHeader.h>

#include <functional>
#include <optional>
#include <vector>

/**
    The pure rules behind the Linux update notice's helpers (SystemUpdateChannel.h):
    what `apt-cache policy` says the package index knows, which desktop updater
    to open, the one package-manager command the app may run, and how to read
    pkexec's exit code. Nothing here touches a process or the disk, so all of
    it is pinned by the Plectrify.UpdateChannel CTest.

    Linux installs update through APT (scripts/aptRepository.ts): the .deb
    registers a sources entry pointing at the signed flat repository the
    release job uploads, and a newer version arrives with the system's own
    updates. The notice learns of a release from GitHub's API the moment it is
    promoted, but APT only sees it after its next index refresh — daily by
    default — so a user who opens Software Updater straight away finds nothing
    and concludes the notice is wrong. These rules are what lets the notice
    say where the index stands instead.
*/
namespace plectrify::updatechannel
{

/** Where the .deb installs the APT source — the same path as
    APT_SOURCES_PATH in scripts/aptRepository.ts, which writes the file. Its
    absence means this machine is no longer subscribed to updates at all. */
constexpr const char* aptSourcesPath = "/etc/apt/sources.list.d/plectrify.sources";

/** The package name the .deb carries (release.linux.ts's control file). */
constexpr const char* packageName = "plectrify";

/** The command whose output candidateVersionFromPolicy() reads. Run through
    `env LC_ALL=C` because apt-cache localises its labels ("Kandidat:" on a
    German desktop) and the parse keys on the English one. */
juce::StringArray policyCommand();

/** The version APT's index offers for the package: the `Candidate:` line of
    `apt-cache policy plectrify`, or empty for `(none)`, for a package APT has
    never heard of, and for anything that is not that output. */
juce::String candidateVersionFromPolicy (const juce::String& policyOutput);

/** A desktop's updates application. `id` is what the page is told and keys
    its button label; `command` is the argv, its first element the bare
    executable name, resolved against PATH before it is run. */
struct SystemUpdater
{
    juce::String id;
    juce::StringArray command;
};

/** The updaters worth trying, most specific first, for the desktop named by
    XDG_CURRENT_DESKTOP (a colon-separated list such as `ubuntu:GNOME`).
    Ubuntu's Software Updater, then GNOME Software and KDE's Discover on their
    updates page — on a KDE session Discover comes first, since Software
    Updater is a GNOME-shaped dialog there even where it is installed. */
std::vector<SystemUpdater> updatersFor (const juce::String& currentDesktop);

/** The first of updatersFor() whose executable `isOnPath` finds, or nullopt
    when the desktop has none the app knows how to open. */
std::optional<SystemUpdater> chooseUpdater (const juce::String& currentDesktop,
                                            const std::function<bool (const juce::String&)>& isOnPath);

/** The argv that refreshes Plectrify's APT source and nothing else, under
    pkexec — polkit's own password prompt, the sudo of the desktop.

    Scoped to the one sources file for three reasons: it is the only index the
    question concerns, a full `apt-get update` can run for a minute against a
    PPA that is down, and a failure then says something about *our* source
    rather than about somebody else's. `APT::Get::List-Cleanup=0` is
    load-bearing: with the source list overridden, apt's default clean-up
    would delete every other repository's index as "no longer configured". */
juce::StringArray refreshCommand();

/** What pkexec's exit code means for the refresh: `done` (0), `declined`
    (126, the user dismissed the password prompt — "not now", not an error)
    or `failed` (127 is pkexec refusing or finding no authentication agent;
    anything else is apt-get's own failure, 100 for an index it could not
    fetch). The page words each. */
juce::String refreshOutcome (juce::uint32 exitCode);

} // namespace plectrify::updatechannel
