#include "SystemUpdateChannel.h"

#include "DetachedProcess.h"

namespace plectrify
{

namespace
{
    // apt-cache reads a local cache; this is a hung machine, not a slow one.
    constexpr int policyTimeoutMs = 15'000;
    // The password prompt can sit for a while, and apt then fetches three
    // small files from GitHub. Past this the run is called off as failed.
    constexpr int refreshTimeoutMs = 5 * 60 * 1000;

    /** `name` resolved against PATH, or a non-existent File. */
    juce::File findOnPath (const juce::String& name)
    {
        juce::StringArray directories;
        directories.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ":", {});

        for (const auto& directory : directories)
        {
            if (directory.isEmpty())
                continue;

            const auto candidate = juce::File (directory).getChildFile (name);
            if (candidate.existsAsFile())
                return candidate;
        }

        return {};
    }

    /** Runs `command` to completion under `timeoutMs` and reports its exit
        code; `output` collects stdout when `captureOutput`. Returns false on a
        process that could not start or outlived the deadline (and is killed),
        and on the pool job it runs in being told to stop — then the process
        is left running: the one that matters is pkexec, whose prompt would
        be orphaned by a kill, and the shell's destructor is what asks.

        The wait is sliced for that, and the job must honour it: a job the
        pool cannot stop is killed by force (pthread_cancel) at shutdown, and
        the forced unwind through the pool's catch-all aborts the process.

        Waited on first and read afterwards, not read while it runs: JUCE's
        pipe read blocks, which would make the deadline unenforceable. The
        commands here print well under the pipe's 64 KB, so none blocks on
        the write side while the parent is waiting. */
    bool runToCompletion (const juce::StringArray& command, int timeoutMs, bool captureOutput,
                          juce::String& output, juce::uint32& exitCode)
    {
        juce::ChildProcess process;
        if (! process.start (command, captureOutput ? juce::ChildProcess::wantStdOut : 0))
            return false;

        const auto* job = juce::ThreadPoolJob::getCurrentThreadPoolJob();
        const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;

        while (! process.waitForProcessToFinish (100))
        {
            if (job != nullptr && job->shouldExit())
                return false;

            if (juce::Time::getMillisecondCounter() >= deadline)
            {
                process.kill();
                return false;
            }
        }

        if (captureOutput)
            output = process.readAllProcessOutput();

        exitCode = process.getExitCode();
        return true;
    }
}

SystemUpdateChannel::SystemUpdateChannel (std::function<void (const State&)> onStateIn)
    : onState (std::move (onStateIn))
{
}

SystemUpdateChannel::~SystemUpdateChannel()
{
    // A job captures `this`; a refresh may be sitting on a password prompt,
    // and killing pkexec from here would only orphan the prompt, so the job
    // is told to stop (runToCompletion's wait honours it within a slice and
    // leaves the process be), the wait is bounded, and the job's callbacks
    // are WeakReference-guarded.
    pool.removeAllJobs (true, 5'000);
}

void SystemUpdateChannel::publish (State next)
{
    state = std::move (next);

    if (onState)
        onState (state);
}

SystemUpdateChannel::State SystemUpdateChannel::read()
{
    State found;
    found.probed = true;

   #if JUCE_LINUX
    found.sourceInstalled = juce::File (updatechannel::aptSourcesPath).existsAsFile();
    found.canRefresh = findOnPath ("pkexec").existsAsFile() && findOnPath ("apt-get").existsAsFile();

    if (const auto updater = updatechannel::chooseUpdater (
            juce::SystemStats::getEnvironmentVariable ("XDG_CURRENT_DESKTOP", {}),
            [] (const juce::String& name) { return findOnPath (name).existsAsFile(); }))
        found.updater = updater->id;

    juce::String output;
    juce::uint32 exitCode = 0;
    if (runToCompletion (updatechannel::policyCommand(), policyTimeoutMs, true, output, exitCode))
        found.candidate = updatechannel::candidateVersionFromPolicy (output);

    juce::Logger::writeToLog ("Update channel: index offers "
                              + (found.candidate.isEmpty() ? juce::String ("nothing") : found.candidate)
                              + ", source " + (found.sourceInstalled ? "present" : "missing")
                              + ", updater " + (found.updater.isEmpty() ? juce::String ("none") : found.updater)
                              + (found.canRefresh ? "" : ", no pkexec"));
   #endif

    return found;
}

void SystemUpdateChannel::probe()
{
    if (busy.exchange (true))
        return;

    juce::WeakReference<SystemUpdateChannel> weak (this);
    pool.addJob ([weak, this]
    {
        auto found = read();
        juce::MessageManager::callAsync ([weak, this, found = std::move (found)]() mutable
        {
            if (weak == nullptr)
                return;
            // A probe never reports a refresh; keep the last outcome on the
            // state so the page's wording survives a re-probe.
            found.refresh = state.refresh == "refreshing" ? juce::String ("idle") : state.refresh;
            busy = false;
            publish (std::move (found));
        });
    });
}

void SystemUpdateChannel::refresh()
{
    if (busy.exchange (true))
        return;

    State begun = state;
    begun.refresh = "refreshing";
    publish (begun);

    juce::WeakReference<SystemUpdateChannel> weak (this);
    pool.addJob ([weak, this]
    {
        juce::String outcome = "failed";

       #if JUCE_LINUX
        juce::String output;
        juce::uint32 exitCode = 0;
        if (runToCompletion (updatechannel::refreshCommand(), refreshTimeoutMs, false, output, exitCode))
            outcome = updatechannel::refreshOutcome (exitCode);

        // Told to stop (the shell is going): pkexec is left to its prompt,
        // and nobody is left to answer to.
        if (juce::ThreadPoolJob::getCurrentThreadPoolJob()->shouldExit())
            return;

        juce::Logger::writeToLog ("Update channel: refresh " + outcome
                                  + (outcome == "done" ? juce::String() : " (exit " + juce::String ((int) exitCode) + ")"));
       #endif

        // What the index knows now, after the refresh, is the answer.
        auto found = read();
        found.refresh = outcome;

        juce::MessageManager::callAsync ([weak, this, found = std::move (found)]() mutable
        {
            if (weak == nullptr)
                return;
            busy = false;
            publish (std::move (found));
        });
    });
}

void SystemUpdateChannel::openUpdater()
{
    if (state.updater.isEmpty())
        return;

   #if JUCE_LINUX
    for (const auto& updater : updatechannel::updatersFor (
             juce::SystemStats::getEnvironmentVariable ("XDG_CURRENT_DESKTOP", {})))
    {
        if (updater.id != state.updater)
            continue;

        auto arguments = updater.command;
        const auto exe = findOnPath (arguments[0]);
        arguments.remove (0);

        if (! exe.existsAsFile() || ! startDetached (exe, arguments))
            juce::Logger::writeToLog ("Update channel: could not start " + state.updater);

        return;
    }
   #endif
}

} // namespace plectrify
