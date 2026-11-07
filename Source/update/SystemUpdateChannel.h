#pragma once

#include <JuceHeader.h>

#include "UpdateChannelRules.h"

#include <atomic>
#include <functional>

/**
    The Linux update notice's host side (HostCapabilities::systemUpdates).

    Linux updates through APT, not through anything the app downloads — the
    .deb registers Plectrify's signed repository and a new version arrives
    with the system's own updates (scripts/aptRepository.ts). The notice
    learns of a release from GitHub the moment it is promoted; APT learns of
    it on its next index refresh, which the desktop runs on its own schedule.
    So what the page needs from here is not an installer but three answers:

      - probe():        what the index knows. Which version APT would install
                        (`apt-cache policy`), whether the sources file the .deb
                        wrote is still there, which updater this desktop has,
                        and whether a refresh can be asked for at all (pkexec).
      - refresh():      refresh Plectrify's source alone, through pkexec —
                        polkit's own password prompt — and then probe again.
                        The one package-manager command the app runs, and it
                        changes nothing on disk but that one index. A refresh
                        that succeeds and still shows nothing newer is the
                        diagnosis the page is after: this machine's source can
                        no longer see the release, and the download is the way
                        back onto the channel.
      - openUpdater():  hand over to the desktop's updates application, which
                        is where the install actually happens.

    Everything is reported on the `updateChannel` stream through onState, so a
    page that reloads mid-refresh asks for the last state on boot like the
    installer's. Threading: one pool thread runs the processes and reports
    through MessageManager::callAsync; everything public is message-thread
    only, and the destructor joins the pool.

    Compiles everywhere so the Windows and mac builds keep it honest; off
    Linux a probe answers with nothing found, and the page never asks there
    (the capability is Linux-only).
*/
namespace plectrify
{

class SystemUpdateChannel
{
public:
    /** One push of the updateChannel stream — the fields
        ui/src/lib/engine/updateChannel.ts reduces over. */
    struct State
    {
        bool probed = false;            ///< false until the first probe has answered
        juce::String updater;           ///< a SystemUpdater id, or empty when none is installed
        juce::String candidate;         ///< the version APT's index offers; empty when none
        bool sourceInstalled = false;   ///< the .deb's sources entry is still on disk
        bool canRefresh = false;        ///< pkexec and apt-get are both on PATH
        juce::String refresh { "idle" }; ///< idle | refreshing | done | declined | failed
    };

    /** `onState` is called on the message thread for every change. */
    explicit SystemUpdateChannel (std::function<void (const State&)> onState);
    ~SystemUpdateChannel();

    /** Reads the index and the desktop and pushes the answer. Ignored while
        a refresh is in flight — that one ends with a probe of its own. */
    void probe();

    /** Refreshes Plectrify's APT source through pkexec, then probes.
        Ignored while one is already running. */
    void refresh();

    /** Starts the desktop's updater found by the last probe, detached, so it
        outlives this app. Nothing happens when no probe has found one. */
    void openUpdater();

    const State& lastState() const noexcept { return state; }

private:
    void publish (State next);
    /** The probe itself; runs on the pool thread. */
    static State read();

    std::function<void (const State&)> onState;
    State state;

    juce::ThreadPool pool { 1 };
    std::atomic<bool> busy { false };

    JUCE_DECLARE_WEAK_REFERENCEABLE (SystemUpdateChannel)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SystemUpdateChannel)
};

} // namespace plectrify
