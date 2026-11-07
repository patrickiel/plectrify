#include "UpdateInstaller.h"

#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
#endif

namespace plectrify
{

namespace
{
    constexpr int connectionTimeoutMs = 10'000;
    constexpr int downloadChunkBytes  = 64 * 1024;
    // The installer is ~40 MB today; a manifest naming something an order of
    // magnitude beyond that is not one we wrote.
    constexpr juce::int64 maxDownloadBytes = 512LL * 1024 * 1024;
    // How long Setup may sit on the UAC prompt before the run is called off.
    constexpr juce::int64 launchTimeoutMs = 3 * 60 * 1000;
    // Inno Setup's exit code for "cancelled before the installation began" —
    // a declined UAC prompt lands here.
    constexpr juce::uint32 setupCancelledExitCode = 2;

   #if JUCE_WINDOWS
    // The mutex Plectrify.iss creates once it is through the UAC prompt.
    constexpr const wchar_t* setupMutexName = L"Global\\PlectrifyUpdateInProgress";
   #endif

    std::unique_ptr<juce::InputStream> openUrl (const juce::String& url, int& status)
    {
        status = 0;
        return juce::URL (url).createInputStream (
            juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                .withConnectionTimeoutMs (connectionTimeoutMs)
                .withStatusCode (&status)
                .withNumRedirectsToFollow (5));
    }

    bool setupMutexExists()
    {
       #if JUCE_WINDOWS
        if (auto handle = OpenMutexW (SYNCHRONIZE, FALSE, setupMutexName))
        {
            CloseHandle (handle);
            return true;
        }
       #endif
        return false;
    }
}

UpdateInstaller::UpdateInstaller (std::function<void (const State&)> onStateIn)
    : onState (std::move (onStateIn))
{
}

UpdateInstaller::~UpdateInstaller()
{
    stopTimer();
    cancelRequested = true;
    // The job captures `this`, so the destructor must not return while it runs.
    pool.removeAllJobs (true, 5'000);
}

juce::File UpdateInstaller::downloadDirectory()
{
    return juce::File::getSpecialLocation (juce::File::tempDirectory)
               .getChildFile ("Plectrify")
               .getChildFile ("updates");
}

void UpdateInstaller::cleanUpLeftovers()
{
    for (const auto& file : downloadDirectory().findChildFiles (juce::File::findFiles, false))
        file.deleteFile();
}

bool UpdateInstaller::isBusy() const noexcept
{
    return state.phase != "idle" && state.phase != "failed";
}

void UpdateInstaller::publish (State next)
{
    state = std::move (next);

    if (onState)
        onState (state);
}

void UpdateInstaller::fail (const juce::String& error)
{
    State next;
    next.phase   = "failed";
    next.version = state.version;
    next.error   = error;
    publish (next);
}

void UpdateInstaller::start (const juce::String& installedVersion)
{
    if (isBusy())
        return;

    State begun;
    begun.phase = "downloading";
    publish (begun);

   #if ! JUCE_WINDOWS
    juce::ignoreUnused (installedVersion);
    fail ("unsupported");
   #else
    cancelRequested = false;

    juce::WeakReference<UpdateInstaller> weak (this);

    // Every report hops to the message thread, and a report that outlives the
    // installer is dropped.
    const auto report = [weak] (std::function<void (UpdateInstaller&)> action)
    {
        juce::MessageManager::callAsync ([weak, action = std::move (action)]
        {
            if (auto* self = weak.get())
                action (*self);
        });
    };

    // `cancelled` is not a failure: the state goes back to idle, which is the
    // offer the user started from.
    const auto finishWith = [report] (juce::String error)
    {
        report ([error] (UpdateInstaller& self)
        {
            if (error == "cancelled")
                self.publish ({});
            else
                self.fail (error);
        });
    };

    pool.addJob ([this, installedVersion, report, finishWith]
    {
        // --- the manifest -----------------------------------------------------
        int status = 0;
        auto manifestStream = openUrl (update::latestAssetUrl (update::manifestFileName), status);

        if (manifestStream == nullptr || status < 200 || status >= 300)
            return finishWith ("network");

        const auto manifest = update::parseReleaseManifest (
            juce::JSON::parse (manifestStream->readEntireStreamAsString()));
        manifestStream.reset();

        if (! manifest)
            return finishWith ("manifest");

        // The page compared the API's tag; this compares what will actually
        // be installed, which differs only while a release is being promoted
        // under us. Either way nothing older or equal is ever run.
        if (! update::isNewerVersion (manifest->version, installedVersion))
            return finishWith ("notNewer");

        if (cancelRequested)
            return finishWith ("cancelled");

        // --- the installer ----------------------------------------------------
        auto stream = openUrl (update::latestAssetUrl (manifest->installer), status);

        if (stream == nullptr || status < 200 || status >= 300)
            return finishWith ("network");

        const auto total = juce::jmax<juce::int64> (0, stream->getTotalLength());

        if (total > maxDownloadBytes)
            return finishWith ("tooLarge");

        const auto version = manifest->version;

        const auto reportProgress = [report, version, total] (juce::int64 received)
        {
            report ([version, received, total] (UpdateInstaller& self)
            {
                State next;
                next.phase         = "downloading";
                next.version       = version;
                next.receivedBytes = received;
                next.totalBytes    = total;
                self.publish (next);
            });
        };

        reportProgress (0);

        const auto directory   = downloadDirectory();
        const auto destination = directory.getChildFile (manifest->installer);
        const auto partial     = destination.getSiblingFile (destination.getFileName() + ".part");

        directory.createDirectory();
        partial.deleteFile();
        destination.deleteFile();

        {
            juce::FileOutputStream out (partial);

            if (out.failedToOpen())
                return finishWith ("disk");

            juce::HeapBlock<char> buffer (downloadChunkBytes);
            juce::int64 received = 0;
            juce::int64 lastReported = 0;

            for (;;)
            {
                if (cancelRequested)
                {
                    out.flush();
                    partial.deleteFile();
                    return finishWith ("cancelled");
                }

                const auto read = stream->read (buffer, downloadChunkBytes);

                if (read <= 0)
                    break;

                if (! out.write (buffer, (size_t) read))
                {
                    out.flush();
                    partial.deleteFile();
                    return finishWith ("disk");
                }

                received += read;

                if (received > maxDownloadBytes)
                {
                    out.flush();
                    partial.deleteFile();
                    return finishWith ("tooLarge");
                }

                // A push per chunk would be hundreds a second on a fast line;
                // one per megabyte is a progress bar that still moves.
                if (received - lastReported >= 1024 * 1024)
                {
                    lastReported = received;
                    reportProgress (received);
                }
            }

            out.flush();

            // A transfer cut short that ends cleanly would otherwise be hashed
            // and refused as a checksum error, which points the user at the
            // wrong thing.
            if (total > 0 && received != total)
            {
                partial.deleteFile();
                return finishWith ("truncated");
            }
        }

        // --- verify against the pinned hash -----------------------------------
        report ([version] (UpdateInstaller& self)
        {
            State next;
            next.phase   = "verifying";
            next.version = version;
            self.publish (next);
        });

        {
            juce::FileInputStream in (partial);

            if (in.failedToOpen())
            {
                partial.deleteFile();
                return finishWith ("disk");
            }

            const juce::SHA256 digest (in);

            if (digest.toHexString().toLowerCase() != manifest->sha256)
            {
                partial.deleteFile();
                return finishWith ("checksum");
            }
        }

        if (! partial.moveFileTo (destination))
        {
            partial.deleteFile();
            return finishWith ("disk");
        }

        report ([destination] (UpdateInstaller& self) { self.launch (destination); });
    });
   #endif
}

void UpdateInstaller::cancel()
{
    // Only a download can be called off. Once Setup is running the outcome is
    // its — and a user who declines the UAC prompt gets the same idle state
    // back through timerCallback.
    if (state.phase == "downloading" || state.phase == "verifying")
        cancelRequested = true;
}

void UpdateInstaller::launch (const juce::File& installer)
{
    const auto logFile = installer.getParentDirectory().getChildFile ("install.log");
    logFile.deleteFile();

    setup = std::make_unique<juce::ChildProcess>();

    // CreateProcess on the as-invoker stub, which puts up the UAC prompt
    // itself and then stays alive as the elevated child's spawn server — so
    // isRunning() answers for the whole installation, and getExitCode() is
    // Setup's own.
    if (! setup->start ("\"" + installer.getFullPathName() + "\" " + update::installerArguments (logFile), 0))
    {
        setup.reset();
        fail ("launch");
        return;
    }

    State next;
    next.phase   = "launching";
    next.version = state.version;
    publish (next);

    launchedAt = juce::Time::currentTimeMillis();
    startTimer (250);
}

void UpdateInstaller::timerCallback()
{
    if (setup == nullptr)
    {
        stopTimer();
        return;
    }

    if (setupMutexExists())
    {
        // Through the UAC prompt: Setup is now waiting for this process to go.
        stopTimer();
        setup.reset();

        State next;
        next.phase   = "installing";
        next.version = state.version;
        publish (next);

        // Out of the timer callback before the window — and the web view the
        // state was just pushed through — is torn down.
        juce::MessageManager::callAsync ([]
        {
            if (auto* app = juce::JUCEApplication::getInstance())
                app->systemRequestedQuit();
        });
        return;
    }

    if (! setup->isRunning())
    {
        const auto exitCode = setup->getExitCode();
        stopTimer();
        setup.reset();

        if (exitCode == setupCancelledExitCode)
            publish ({});          // declined the prompt: back to the offer
        else
            fail ("launch");
        return;
    }

    if (juce::Time::currentTimeMillis() - launchedAt > launchTimeoutMs)
    {
        stopTimer();
        setup.reset();
        fail ("launch");
    }
}

} // namespace plectrify
