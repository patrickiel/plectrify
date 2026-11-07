#pragma once

#include <JuceHeader.h>

#include "UpdateChannelRules.h"

#include <functional>

/**
    The Linux update notice's host side (HostCapabilities::systemUpdates).

    Linux updates through APT, not through anything the app downloads — the
    .deb registers Plectrify's signed repository and a new version arrives
    with the system's own updates (scripts/aptRepository.ts). The notice
    learns of a release from GitHub the moment it is promoted; APT learns of
    it on its next index refresh, which the desktop runs on its own schedule.
    So what the page needs from here is not an installer but two things:

      - probe():        what the index knows. Which version APT would install
                        (`apt-cache policy`, a local read that needs no
                        password), whether the sources file the .deb wrote is
                        still there, and which updater this desktop has.
      - openUpdater():  hand over to the desktop's updates application, which
                        is where the install actually happens.

    Deliberately no refresh of the index from here. It would be `pkexec
    apt-get update` — a password prompt, a root process the app cannot end,
    and exit codes to word — to turn a one-line terminal command into a
    click; the notice prints the command instead. The app never runs a
    package-manager command that changes anything.

    Everything is reported on the `updateChannel` stream through onState.
    Threading: one pool thread runs apt-cache and reports through
    MessageManager::callAsync; everything public is message-thread only, and
    the destructor joins the pool.

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
    };

    /** `onState` is called on the message thread for every change. */
    explicit SystemUpdateChannel (std::function<void (const State&)> onState);
    ~SystemUpdateChannel();

    /** Reads the index and the desktop and pushes the answer. A probe already
        in flight answers for this one. */
    void probe();

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
    bool probing = false; ///< message-thread only, like everything public here

    JUCE_DECLARE_WEAK_REFERENCEABLE (SystemUpdateChannel)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SystemUpdateChannel)
};

} // namespace plectrify
