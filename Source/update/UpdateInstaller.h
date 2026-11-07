#pragma once

#include <JuceHeader.h>

#include "UpdateManifest.h"

#include <atomic>
#include <functional>
#include <memory>

/**
    Installs a newer Plectrify from inside the app, on Windows.

    The whole job, in order: fetch the release manifest of the newest promoted
    release, check it names a newer version than this one, download its
    installer, verify the SHA-256 the manifest pins, start the installer
    silently — and only once the installer has made it past the UAC prompt,
    quit, so that it can replace the files and relaunch the new version.

    Why the app does not simply "launch and quit". Inno Setup's Setup.exe runs
    as-invoker and re-spawns itself elevated, so the UAC prompt belongs to
    Setup, not to our launch call, which succeeds at once either way. A user
    who declines the prompt gets exit code 2 and nothing on screen; had we
    already quit, they would be left with no app and no word why. So Setup
    tells us when it is through: packaging/windows/Plectrify.iss creates the
    mutex `Global\PlectrifyUpdateInProgress` in InitializeSetup (which only
    runs in the elevated child), and this class polls for it while Setup is
    alive. Mutex seen → `installing`, quit. Setup gone first → back to the
    offer (a declined prompt) or `failed`, with the installer kept on disk.
    Setup then waits for JUCE's single-instance mutex to clear before it
    touches a file, and relaunches the app non-elevated when it is done.

    Where the download lands: `<temp>/Plectrify/updates/`, not the per-user
    data root, which on Windows is the roaming %APPDATA% — a 40 MB installer
    has no business roaming, and the folder is also outside the page's file
    sandbox. The file our own process writes carries no Mark-of-the-Web, so
    SmartScreen never interposes; the hash check against the manifest is the
    integrity gate, and both are fetched over TLS from the same GitHub release.
    cleanUpLeftovers() empties the folder on launch (a file the still-running
    installer holds fails to delete and goes next time).

    Threading: one pool thread does the network and disk work and reports
    through MessageManager::callAsync; everything public is message-thread
    only. The destructor cancels and joins the pool, and every queued callback
    is WeakReference-guarded.

    Compiles on every platform so the mac and Linux builds keep it honest; off
    Windows start() reports `unsupported`, and the page never offers it there
    (HostCapabilities::selfUpdate).
*/
namespace plectrify
{

class UpdateInstaller : private juce::Timer
{
public:
    /** One push of the updateInstallState stream. `phase` is one of the
        strings ui/src/lib/engine/updateInstall.ts reduces over: idle,
        downloading, verifying, launching, installing, failed. */
    struct State
    {
        juce::String phase { "idle" };
        juce::String version;         ///< what is being installed, once the manifest is read
        juce::int64  receivedBytes = 0;
        juce::int64  totalBytes    = 0; ///< 0 while unknown
        juce::String error;           ///< a short token on `failed` (see describeUpdateInstallError)
    };

    /** `onState` is called on the message thread for every change. */
    explicit UpdateInstaller (std::function<void (const State&)> onState);
    ~UpdateInstaller() override;

    /** Begins the run described above. Ignored while one is in flight. */
    void start (const juce::String& installedVersion);

    /** Stops a download; the state returns to idle. Nothing to cancel once
        the installer has been started — from there Setup owns the outcome. */
    void cancel();

    /** True from start() until the run ends — the standalone's
        blocksAutoStandby() reads it, since a multi-minute idle download must
        not be parked. */
    bool isBusy() const noexcept;

    const State& lastState() const noexcept { return state; }

    /** `<temp>/Plectrify/updates` — see the class comment. */
    static juce::File downloadDirectory();

    /** Removes what an earlier run left in downloadDirectory(). Called on
        launch; failures are ignored. */
    static void cleanUpLeftovers();

private:
    void publish (State next);
    void fail (const juce::String& error);
    void launch (const juce::File& installer);
    void timerCallback() override;

    std::function<void (const State&)> onState;
    State state;

    juce::ThreadPool pool { 1 };
    std::atomic<bool> cancelRequested { false };

    std::unique_ptr<juce::ChildProcess> setup;
    juce::int64 launchedAt = 0;

    JUCE_DECLARE_WEAK_REFERENCEABLE (UpdateInstaller)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (UpdateInstaller)
};

} // namespace plectrify
