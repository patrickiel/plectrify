#include "PluginScanWorker.h"

#include <chrono>

#if JUCE_WINDOWS
 #include <windows.h>
#else
 #include <unistd.h>
#endif

namespace plectrify::scanworker
{
    namespace
    {
        // A request is a magic word and two length-prefixed UTF-8 strings. The
        // word is what tells a malformed block from a request whose strings
        // happen to parse; the lengths are what make a truncated one fail
        // instead of yielding a shorter path.
        constexpr juce::int32 requestMagic = 0x50534352; // 'PSCR'

        void writeSizedString (juce::OutputStream& out, const juce::String& text)
        {
            const auto bytes = (int) text.getNumBytesAsUTF8();
            out.writeInt (bytes);
            out.write (text.toRawUTF8(), (size_t) bytes);
        }

        std::optional<juce::String> readSizedString (juce::InputStream& in)
        {
            if (in.getNumBytesRemaining() < (juce::int64) sizeof (juce::int32))
                return std::nullopt;

            const auto bytes = in.readInt();
            if (bytes < 0 || (juce::int64) bytes > in.getNumBytesRemaining())
                return std::nullopt;

            juce::MemoryBlock raw ((size_t) bytes);
            if (bytes > 0 && in.read (raw.getData(), bytes) != bytes)
                return std::nullopt;

            const auto* chars = static_cast<const char*> (raw.getData());
            if (! juce::CharPointer_UTF8::isValidString (chars, bytes))
                return std::nullopt;

            return juce::String::fromUTF8 (chars, bytes);
        }
        constexpr const char* resultsTag = "PLECTRIFY_SCAN_RESULTS";

        juce::String commandLinePrefix()
        {
            // The shape ChildProcessCoordinator::launchWorkerProcess builds and
            // ChildProcessWorker::initialiseFromCommandLine looks for.
            return "--" + juce::String (commandLineId) + ":";
        }

        /** How long a freshly launched worker has to connect its pipe, and the
            app side's ping timeout. Short on purpose: a worker that cannot come
            up should fail the launch in seconds, not stall the first file for
            two minutes. Pings keep arriving from the worker's own ping thread
            while its IPC thread is inside a plugin's load, so the app side
            never needs the long timeout the worker side does. */
        constexpr int launchTimeoutMs = 10'000;

        /** Ends this process without unwinding anything. A plugin that has
            wedged a thread may hold a lock every orderly exit path needs; on
            Windows ExitProcess still runs every loaded DLL's detach, which is
            the plugin's code again. */
        void hardExit()
        {
           #if JUCE_WINDOWS
            TerminateProcess (GetCurrentProcess(), 1);
           #else
            _exit (1);
           #endif
        }

       #if JUCE_WINDOWS
        /** The worker's whole crash handling: one log line, then let the OS end
            the process — EXCEPTION_EXECUTE_HANDLER from the top-level filter
            terminates it without the Error Reporting dialog. No minidump: a
            third-party plugin crashing is not a Plectrify bug to debug, and a
            dump per crashing plugin per scan would fill crashes/. The app logs
            which file it was from the other end. */
        LONG WINAPI quietCrashExit (EXCEPTION_POINTERS* info)
        {
            if (info != nullptr && info->ExceptionRecord != nullptr)
                juce::Logger::writeToLog ("CRASH: exception 0x"
                    + juce::String::toHexString ((juce::int64) info->ExceptionRecord->ExceptionCode)
                    + " at 0x"
                    + juce::String::toHexString ((juce::pointer_sized_int) info->ExceptionRecord->ExceptionAddress)
                    + " — the scan worker is exiting");

            return EXCEPTION_EXECUTE_HANDLER;
        }
       #endif
    }

    bool isWorkerCommandLine (const juce::String& commandLine)
    {
        return commandLine.trim().startsWith (commandLinePrefix());
    }

    void addHostedFormats (juce::AudioPluginFormatManager& manager)
    {
        juce::ignoreUnused (manager); // a test build hosts no format at all

       #if JUCE_PLUGINHOST_VST3
        manager.addFormat (std::make_unique<juce::VST3PluginFormat>());
       #endif

       #if JUCE_PLUGINHOST_VST
        // The VST2-era format (.dll / .vst / .so), compiled against the FST
        // header — see CMakeLists.txt for why that is possible and the rules
        // that come with it. JUCE's own class: the scan, the cache, the
        // blacklist and instantiation know nothing format-specific, and a
        // description's identifier string embeds the format name, so a .dll
        // and a .vst3 of the same plugin are two entries that never stand in
        // for each other.
        manager.addFormat (std::make_unique<juce::VSTPluginFormat>());
       #endif
    }

    juce::MemoryBlock encodeRequest (const Request& request)
    {
        juce::MemoryBlock block;
        {
            juce::MemoryOutputStream out (block, false);
            out.writeInt (requestMagic);
            writeSizedString (out, request.formatName);
            writeSizedString (out, request.fileOrIdentifier);
        }
        return block;
    }

    std::optional<Request> decodeRequest (const juce::MemoryBlock& block)
    {
        juce::MemoryInputStream in (block, false);

        if (in.getNumBytesRemaining() < (juce::int64) sizeof (juce::int32) || in.readInt() != requestMagic)
            return std::nullopt;

        const auto formatName = readSizedString (in);
        const auto fileOrIdentifier = readSizedString (in);

        if (! formatName.has_value() || ! fileOrIdentifier.has_value()
            || formatName->isEmpty() || fileOrIdentifier->isEmpty() || ! in.isExhausted())
            return std::nullopt;

        return Request { *formatName, *fileOrIdentifier };
    }

    juce::MemoryBlock encodeResults (const juce::OwnedArray<juce::PluginDescription>& found)
    {
        juce::XmlElement xml (resultsTag);

        for (const auto* description : found)
            xml.addChildElement (description->createXml().release());

        const auto text = xml.toString();
        return { text.toRawUTF8(), text.getNumBytesAsUTF8() };
    }

    bool decodeResults (const juce::MemoryBlock& block, juce::OwnedArray<juce::PluginDescription>& into)
    {
        const auto xml = juce::parseXML (block.toString());

        if (xml == nullptr || ! xml->hasTagName (resultsTag))
            return false;

        // Decoded whole before anything is appended, so a bad element in the
        // middle leaves `into` untouched.
        juce::OwnedArray<juce::PluginDescription> decoded;

        for (const auto* child : xml->getChildIterator())
        {
            auto description = std::make_unique<juce::PluginDescription>();

            if (! description->loadFromXml (*child))
                return false;

            decoded.add (std::move (description));
        }

        while (! decoded.isEmpty())
            into.add (decoded.removeAndReturn (0));

        return true;
    }
}

//==============================================================================
PluginScanWorker::PluginScanWorker()
{
    plectrify::scanworker::addHostedFormats (formatManager);
}

PluginScanWorker::~PluginScanWorker()
{
    cancelPendingUpdate();
}

bool PluginScanWorker::start (const juce::String& commandLine)
{
   #if JUCE_WINDOWS
    // A plugin whose dependency is missing would otherwise stop the whole
    // scan on a system message box nobody can see behind the app; a plugin
    // that crashes would raise Error Reporting's. Both are this process's
    // business alone now, so neither gets a dialog.
    SetErrorMode (SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetUnhandledExceptionFilter (plectrify::scanworker::quietCrashExit);
   #endif

   #if JUCE_MAC
    // A second Plectrify bouncing in the Dock for every scan would be alarming,
    // and this one has no window to show.
    juce::Process::setDockIconVisible (false);
   #endif

    return initialiseFromCommandLine (commandLine,
                                      plectrify::scanworker::commandLineId,
                                      plectrify::scanworker::connectionTimeoutMs);
}

void PluginScanWorker::handleMessageFromCoordinator (const juce::MemoryBlock& mb)
{
    if (mb.isEmpty())
        return;

    // On the IPC thread. A format that insists on the message thread for
    // instantiation is deferred there; everything else loads right here, which
    // keeps the message thread free to quit this process if the app goes away.
    const auto request = plectrify::scanworker::decodeRequest (mb);
    const auto needsMessageThread = [&]
    {
        if (! request.has_value())
            return false;

        for (auto* format : formatManager.getFormats())
        {
            if (format->getName() == request->formatName)
            {
                juce::PluginDescription description;
                description.fileOrIdentifier = request->fileOrIdentifier;
                description.uniqueId = description.deprecatedUid = 0;
                return format->requiresUnblockedMessageThreadDuringCreation (description);
            }
        }

        return false;
    }();

    if (needsMessageThread && ! juce::MessageManager::getInstance()->isThisTheMessageThread())
    {
        const std::lock_guard<std::mutex> lock (mutex);
        pendingOnMessageThread.push (mb);
        triggerAsyncUpdate();
        return;
    }

    reply (scan (mb));
}

void PluginScanWorker::handleAsyncUpdate()
{
    for (;;)
    {
        juce::MemoryBlock next;
        {
            const std::lock_guard<std::mutex> lock (mutex);

            if (pendingOnMessageThread.empty())
                return;

            next = std::move (pendingOnMessageThread.front());
            pendingOnMessageThread.pop();
        }

        reply (scan (next));
    }
}

juce::OwnedArray<juce::PluginDescription> PluginScanWorker::scan (const juce::MemoryBlock& block)
{
    juce::OwnedArray<juce::PluginDescription> found;

    // A malformed request is answered rather than ignored, or the app would
    // wait out the whole file timeout for it.
    const auto request = plectrify::scanworker::decodeRequest (block);
    if (! request.has_value())
        return found;

    for (auto* format : formatManager.getFormats())
    {
        if (format->getName() == request->formatName)
        {
            // The last of these lines in plectrify-scan.log names the file a
            // dead worker was loading.
            juce::Logger::writeToLog ("Scanning " + request->fileOrIdentifier);
            format->findAllTypesForFile (found, request->fileOrIdentifier);
            break;
        }
    }

    return found;
}

void PluginScanWorker::reply (const juce::OwnedArray<juce::PluginDescription>& found)
{
    sendMessageToCoordinator (plectrify::scanworker::encodeResults (found));
}

void PluginScanWorker::handleConnectionLost()
{
    // The app has gone, or ended the scan. Quit — and in case a plugin has this
    // process's IPC thread wedged so that the orderly quit never completes (the
    // reason the app gave up on this worker in the first place), a watchdog
    // ends it the hard way a few seconds later. Nothing here is worth saving.
    juce::Thread::launch ([]
    {
        juce::Thread::sleep (5000);
        plectrify::scanworker::hardExit();
    });

    juce::JUCEApplicationBase::quit();
}

//==============================================================================
/** The ChildProcessCoordinator: launches the worker, forwards requests, and
    hands its replies — or its death — across to the scan thread waiting in
    OutOfProcessPluginScanner::ask. */
class OutOfProcessPluginScanner::Worker final : private juce::ChildProcessCoordinator
{
public:
    Worker() = default;

    ~Worker() override
    {
        // Ends the connection *here*, while the mutex and the reply block below
        // still exist. The base destructor would do it too, but only after
        // this class's members are gone — and until the connection's read
        // thread has been stopped, a reply still coming in lands in
        // handleMessageFromWorker, writing into destroyed members. That was
        // issue #40's own fix crashing: a scan ended with a reply in flight.
        // The worker process quits by itself on losing the connection.
        killWorkerProcess();
    }

    bool launch (const juce::File& executable)
    {
        // No stdout/stderr pipes: nothing reads them, and a worker blocked on
        // a full pipe would look exactly like a hung plugin.
        return launchWorkerProcess (executable,
                                    plectrify::scanworker::commandLineId,
                                    plectrify::scanworker::launchTimeoutMs,
                                    /*streamFlags*/ 0);
    }

    bool send (const juce::MemoryBlock& request)
    {
        return sendMessageToWorker (request);
    }

    enum class State { waiting, replied, lost };

    struct Response
    {
        State state;
        juce::MemoryBlock message;
    };

    /** Waits up to `ms` for a reply or the connection's end. `lost` is sticky:
        a worker that has died stays dead for every later question. */
    Response waitFor (int ms)
    {
        std::unique_lock<std::mutex> lock (mutex);

        if (! condition.wait_for (lock, std::chrono::milliseconds (ms), [&] { return replied || lost; }))
            return { State::waiting, {} };

        if (lost)
            return { State::lost, {} };

        // Swapped out rather than moved: juce::MemoryBlock's move constructor
        // takes the buffer but leaves the old size behind, so a moved-from
        // `reply` reads as N bytes at a null pointer — and the next reply of
        // exactly N bytes makes the copy's setSize a no-op and its memcpy a
        // write to null. Two plugin descriptions of the same length in a row
        // was all it took (first seen with the starter bundle on Linux).
        Response response { State::replied, {} };
        response.message.swapWith (reply);
        replied = false;
        return response;
    }

private:
    void handleMessageFromWorker (const juce::MemoryBlock& mb) override
    {
        const std::lock_guard<std::mutex> lock (mutex);
        reply = mb;
        replied = true;
        condition.notify_one();
    }

    void handleConnectionLost() override
    {
        const std::lock_guard<std::mutex> lock (mutex);
        lost = true;
        condition.notify_one();
    }

    std::mutex mutex;
    std::condition_variable condition;
    juce::MemoryBlock reply;
    bool replied = false;
    bool lost = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Worker)
};

OutOfProcessPluginScanner::OutOfProcessPluginScanner (juce::File workerExecutable,
                                                      std::function<bool()> shouldAbandonScan)
    : executable (std::move (workerExecutable)),
      shouldAbandon (std::move (shouldAbandonScan))
{
}

OutOfProcessPluginScanner::~OutOfProcessPluginScanner() = default;

void OutOfProcessPluginScanner::scanFinished()
{
    worker = nullptr;
}

bool OutOfProcessPluginScanner::findPluginTypesFor (juce::AudioPluginFormat& format,
                                                    juce::OwnedArray<juce::PluginDescription>& result,
                                                    const juce::String& fileOrIdentifier)
{
    const auto log = [] (const juce::String& line) { juce::Logger::writeToLog ("Plugin scan: " + line); };
    const auto inProcess = [&]
    {
        format.findAllTypesForFile (result, fileOrIdentifier);
        return true;
    };

    if (inProcessFallback)
        return inProcess();

    // Two rounds: the first may find the previous worker gone (killed by what
    // its last file left running), which is nobody's fault here and simply
    // means a fresh one answers instead.
    for (int attempt = 0; attempt < 2; ++attempt)
    {
        if (worker == nullptr)
        {
            auto fresh = std::make_unique<Worker>();

            if (! fresh->launch (executable))
            {
                log ("could not start a scan process from " + executable.getFullPathName()
                     + "; scanning in this process instead");
                inProcessFallback = true;
                return inProcess();
            }

            worker = std::move (fresh);
            workerHasAnswered = false;
        }

        switch (ask (format.getName(), fileOrIdentifier, result))
        {
            case Outcome::found:
                workerHasAnswered = true;
                launchesThatDiedUnanswered = 0;
                return true;

            case Outcome::badReply:
                // Loaded, answered, and the answer was unreadable: a bug on
                // our side, not the plugin's. Not blacklisted; logged.
                log ("unreadable reply for " + fileOrIdentifier);
                workerHasAnswered = true;
                return true;

            case Outcome::notSent:
                // Gone before this file was even asked for.
                log ("the scan process had already ended before " + fileOrIdentifier + "; starting another");
                worker = nullptr;
                continue;

            case Outcome::died:
                worker = nullptr;

                if (! workerHasAnswered && ++launchesThatDiedUnanswered >= 2)
                {
                    // Two fresh workers dead without describing a single
                    // file: the worker itself is not running here. Blaming
                    // this file would be a guess, so it is left for the next
                    // scan, and the rest of this one loads in-process.
                    log ("two scan processes in a row died before answering; scanning in this process instead");
                    inProcessFallback = true;
                    return true;
                }

                log ("the scan process died loading " + fileOrIdentifier + "; it is skipped from now on");
                return false;

            case Outcome::hung:
                log (fileOrIdentifier + " did not finish loading within "
                     + juce::String (plectrify::scanworker::fileTimeoutMs / 1000)
                     + " s; the scan process was ended and the file is skipped from now on");
                worker = nullptr;
                return false;

            case Outcome::abandoned:
                worker = nullptr;
                return true;
        }
    }

    // Two launches, two connections gone before a request could be sent:
    // treated like two unanswered deaths.
    log ("the scan process keeps ending before it can be asked anything; scanning in this process instead");
    inProcessFallback = true;
    return true;
}

OutOfProcessPluginScanner::Outcome OutOfProcessPluginScanner::ask (const juce::String& formatName,
                                                                   const juce::String& fileOrIdentifier,
                                                                   juce::OwnedArray<juce::PluginDescription>& result)
{
    if (! worker->send (plectrify::scanworker::encodeRequest ({ formatName, fileOrIdentifier })))
        return Outcome::notSent;

    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) plectrify::scanworker::fileTimeoutMs;

    for (;;)
    {
        if (shouldAbandon != nullptr && shouldAbandon())
            return Outcome::abandoned;

        auto response = worker->waitFor (50);

        switch (response.state)
        {
            case Worker::State::waiting:
                if (juce::Time::getMillisecondCounter() >= deadline)
                    return Outcome::hung;
                break;

            case Worker::State::lost:
                return Outcome::died;

            case Worker::State::replied:
                return plectrify::scanworker::decodeResults (response.message, result) ? Outcome::found
                                                                                        : Outcome::badReply;
        }
    }
}
