#pragma once

#include <JuceHeader.h>

#include <condition_variable>
#include <functional>
#include <mutex>
#include <optional>
#include <queue>

/**
    Plugin scanning in a process of its own.

    A scan instantiates every plugin file it finds, and a plugin is arbitrary
    code: one that crashes takes the process down, and one that leaves a
    thread, a timer or a window procedure running after it is unloaded takes it
    down a little later — seconds after the scan reported "complete", which is
    exactly what issue #40 looked like, with no dump and no log line because
    the plugin had also replaced the crash handler on its way through. So the
    standalone no longer loads a plugin it is only looking at: the scan thread
    hands each file to a **worker** — a second copy of this very executable,
    launched with a command line that tells it to be one — and the worker
    loads the file, describes what it found and sends the description back.
    A worker that dies costs one blacklist entry instead of the app, and
    whatever a plugin left running dies with the worker when the scan ends.

    Three parts, all in this file because they are one protocol:

    - `scanworker::` — the wire format (a request names a format and a file; a
      reply is the found PluginDescriptions as XML), the command-line marker
      a worker is recognised by, and the timeouts. Pure, tested
      (Tests/plugins/PluginScanWorkerTests.cpp).
    - `PluginScanWorker` — the worker process's side. Main.cpp constructs one
      instead of the main window when the command line says so.
    - `OutOfProcessPluginScanner` — the app's side, a
      KnownPluginList::CustomScanner that JUCE's PluginDirectoryScanner calls
      for every file. It launches a worker lazily, relaunches one that died,
      and reports a death as "this file could not be loaded" — which is what
      KnownPluginList turns into a blacklist entry.

    What the VST3 plugin build does: nothing of this. Inside a DAW the
    executable is the DAW's, so there is no worker to launch, and
    PluginManager scans in-process there exactly as before (with the
    dead-man's-pedal file). HostServices::pluginScanWorkerExecutable() is the
    switch — see PluginManager::setScanWorkerExecutable.

    THREADING. OutOfProcessPluginScanner runs on the scan thread; the worker
    connection's callbacks arrive on JUCE's IPC thread (and, for a ping
    timeout, on the message thread), so the reply is handed over through a
    mutex and a condition variable. The worker process handles each request on
    its IPC thread unless the format insists on the message thread, in which
    case it is deferred there — the same arrangement JUCE's AudioPluginHost
    uses.
*/
namespace plectrify::scanworker
{
    /** The command-line id JUCE's ChildProcessCoordinator builds the worker's
        argument from: the worker is started as
        `Plectrify --plectrify-scan-worker:<pipe name>`. Never typed by a user. */
    inline const char* const commandLineId = "plectrify-scan-worker";

    /** Whether `commandLine` (JUCE's single string, as handed to
        JUCEApplication::initialise) is a coordinator launching a worker. Must
        agree with ChildProcessWorker::initialiseFromCommandLine, which is why
        it trims and matches the prefix the same way. */
    bool isWorkerCommandLine (const juce::String& commandLine);

    /** How long one plugin file may take to describe itself before the worker
        is presumed hung, killed and the file blacklisted. Generous: a large
        sampler's first load can take a while, and the price of a wrong guess
        is a plugin the user has to Retry. */
    constexpr int fileTimeoutMs = 90'000;

    /** The worker side's IPC ping timeout, which has to outlast fileTimeoutMs:
        while the worker is inside a plugin's load its pings are not read, and
        the connection must not be declared dead for that alone. The app's
        death is noticed through the pipe on every platform, so for the worker
        this is only ever the hang case. (The app side is the other way round
        on Windows — see OutOfProcessPluginScanner::Worker.) */
    constexpr int connectionTimeoutMs = 120'000;
    static_assert (connectionTimeoutMs > fileTimeoutMs, "a load must not outlive the connection");

    /** The plugin formats Plectrify hosts, in one place for the two
        AudioPluginFormatManagers that must agree on them: the app's
        PluginManager and the worker. VST3, plus the VST2-era single-file
        format when the build enables it (see PluginManager.h). */
    void addHostedFormats (juce::AudioPluginFormatManager& manager);

    // --- Wire format ---------------------------------------------------------

    struct Request
    {
        juce::String formatName;        ///< AudioPluginFormat::getName()
        juce::String fileOrIdentifier;  ///< what the format's scanner found
    };

    juce::MemoryBlock encodeRequest (const Request& request);
    /** nullopt for anything that is not a well-formed request. */
    std::optional<Request> decodeRequest (const juce::MemoryBlock& block);

    juce::MemoryBlock encodeResults (const juce::OwnedArray<juce::PluginDescription>& found);
    /** Appends the decoded descriptions to `into`; false (and nothing appended)
        for a malformed reply. An empty list is a valid reply: the worker
        loaded the file and found no plugin in it. */
    bool decodeResults (const juce::MemoryBlock& block, juce::OwnedArray<juce::PluginDescription>& into);

    /** The worker's first message once connected: its process id, which is how
        the app watches the process itself rather than only the pipe (see
        OutOfProcessPluginScanner::Worker). Sent before any reply, and never
        mistakable for one: a reply is XML, this is a magic word and a number. */
    juce::MemoryBlock encodeHello (juce::int64 processId);
    /** nullopt for anything that is not a hello. */
    std::optional<juce::int64> decodeHello (const juce::MemoryBlock& block);
}

//==============================================================================
/**
    The worker process. One per scan (per format, strictly: JUCE ends the
    scanner once per PluginDirectoryScanner, and PluginManager builds one per
    format), living for as long as the app keeps it connected and quitting the
    moment that connection goes.

    Owned by PlectrifyApplication in place of the main window. It installs
    nothing else — no crash dumps, no window, on macOS no Dock icon — and
    suppresses the OS's own error boxes, so a plugin that crashes or is missing
    a dependency ends the process quietly; the app logs which file it was.
*/
class PluginScanWorker final : private juce::ChildProcessWorker,
                               private juce::AsyncUpdater
{
public:
    PluginScanWorker();
    ~PluginScanWorker() override;

    /** Connects to the coordinator named on `commandLine`. False when the
        command line is not a worker launch or the pipe could not be opened,
        in which case the process has nothing to do and should quit. */
    bool start (const juce::String& commandLine);

private:
    void handleMessageFromCoordinator (const juce::MemoryBlock& mb) override;
    void handleConnectionMade() override;
    void handleConnectionLost() override;
    void handleAsyncUpdate() override;

    juce::OwnedArray<juce::PluginDescription> scan (const juce::MemoryBlock& request);
    void reply (const juce::OwnedArray<juce::PluginDescription>& found);

    std::mutex mutex;
    std::queue<juce::MemoryBlock> pendingOnMessageThread;
    juce::AudioPluginFormatManager formatManager;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginScanWorker)
};

//==============================================================================
/**
    The app's side: a KnownPluginList::CustomScanner that answers every
    findPluginTypesFor through a worker process.

    Installed once on PluginManager's KnownPluginList
    (PluginManager::setScanWorkerExecutable) and from then on consulted by
    KnownPluginList::scanAndAddFile for each file a scan reaches. Returning
    false there is what blacklists the file, so false means precisely "the
    worker died or hung while loading this one". Everything else — a file
    that loads and holds no plugin, a scan being abandoned, even a worker that
    cannot be started at all — returns true, with whatever (possibly nothing)
    was found.

    Attribution is the one subtlety. A worker that died *between* files — its
    last plugin left something running that faulted after the load returned —
    is discovered when the next request fails to send, and that next file is
    innocent. So a failed send relaunches and retries without blaming anyone;
    only a connection lost *after* a request was sent is charged to that
    request's file. Two launches in a row that die before answering anything
    mean the worker itself cannot run here, and the rest of the scan falls
    back to loading in-process (logged), because a scan that finds nothing is
    worse than one that risks the app — the choice the app always made before
    this existed.
*/
class OutOfProcessPluginScanner final : public juce::KnownPluginList::CustomScanner
{
public:
    /** `workerExecutable` is launched for each scan; `shouldAbandon` is polled
        while waiting on the worker (the scan thread's threadShouldExit — the
        base class's shouldExit() only knows about ThreadPoolJobs). */
    OutOfProcessPluginScanner (juce::File workerExecutable, std::function<bool()> shouldAbandon);
    ~OutOfProcessPluginScanner() override;

    bool findPluginTypesFor (juce::AudioPluginFormat& format,
                             juce::OwnedArray<juce::PluginDescription>& result,
                             const juce::String& fileOrIdentifier) override;

    /** Ends the worker. Called by KnownPluginList when a PluginDirectoryScanner
        is destroyed; the next scan starts a fresh one. */
    void scanFinished() override;

private:
    class Worker;   // the ChildProcessCoordinator and its reply hand-over

    enum class Outcome { found, badReply, notSent, died, hung, abandoned };
    Outcome ask (const juce::String& formatName,
                 const juce::String& fileOrIdentifier,
                 juce::OwnedArray<juce::PluginDescription>& result);
    /** Lets go of `worker` after it died — off this thread when ending it
        would block (Windows, see Worker). A live worker is ended in place. */
    void discardWorker();

    const juce::File executable;
    const std::function<bool()> shouldAbandon;
    std::unique_ptr<Worker> worker;
    bool workerHasAnswered = false;         // this worker has described at least one file
    int launchesThatDiedUnanswered = 0;
    bool inProcessFallback = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (OutOfProcessPluginScanner)
};
