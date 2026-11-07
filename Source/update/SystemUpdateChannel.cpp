#include "SystemUpdateChannel.h"

#include "DetachedProcess.h"

namespace plectrify
{

namespace
{
   #if JUCE_LINUX
    // apt-cache reads a local cache; this is a hung machine, not a slow one.
    constexpr int policyTimeoutMs = 15'000;

    /** `name` resolved against PATH, or a non-existent File. Only absolute
        entries are searched: a relative one (`.`, `bin`) names a different
        place from every working directory — and juce::File asserts on one. */
    juce::File findOnPath (const juce::String& name)
    {
        juce::StringArray directories;
        directories.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ":", {});

        for (const auto& directory : directories)
        {
            if (! directory.startsWithChar ('/'))
                continue;

            const auto candidate = juce::File (directory).getChildFile (name);
            if (candidate.existsAsFile())
                return candidate;
        }

        return {};
    }

    /** `command`'s stdout, or nothing for a command that could not start,
        outlived `timeoutMs` (and is killed), or was still running when the
        pool job it runs in was told to stop — the wait is sliced for that: a
        job the pool cannot stop is killed by force at shutdown, and the
        forced unwind through the pool's catch-all aborts the process.

        Waited on first and read afterwards; apt-cache policy prints a few
        lines, far under the pipe's capacity. Nothing here depends on the
        exit code: a child that ends any other way than printing the index
        reads as an index that offers nothing, which is the safe answer. */
    juce::String outputOf (const juce::StringArray& command, int timeoutMs)
    {
        juce::ChildProcess process;
        if (! process.start (command, juce::ChildProcess::wantStdOut))
            return {};

        const auto* job = juce::ThreadPoolJob::getCurrentThreadPoolJob();
        const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;

        while (! process.waitForProcessToFinish (100))
        {
            if (job != nullptr && job->shouldExit())
                return {};

            if (juce::Time::getMillisecondCounter() >= deadline)
            {
                process.kill();
                return {};
            }
        }

        return process.readAllProcessOutput();
    }
   #endif
}

SystemUpdateChannel::SystemUpdateChannel (std::function<void (const State&)> onStateIn)
    : onState (std::move (onStateIn))
{
}

SystemUpdateChannel::~SystemUpdateChannel()
{
    // A job captures `this`: it is told to stop (outputOf's wait honours it
    // within a slice), the wait is bounded, and the job's callback is
    // WeakReference-guarded.
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

    if (const auto updater = updatechannel::chooseUpdater (
            juce::SystemStats::getEnvironmentVariable ("XDG_CURRENT_DESKTOP", {}),
            [] (const juce::String& name) { return findOnPath (name).existsAsFile(); }))
        found.updater = updater->id;

    found.candidate = updatechannel::candidateVersionFromPolicy (
        outputOf (updatechannel::policyCommand(), policyTimeoutMs));

    juce::Logger::writeToLog ("Update channel: index offers "
                              + (found.candidate.isEmpty() ? juce::String ("nothing") : found.candidate)
                              + ", source " + (found.sourceInstalled ? "present" : "missing")
                              + ", updater " + (found.updater.isEmpty() ? juce::String ("none") : found.updater));
   #endif

    return found;
}

void SystemUpdateChannel::probe()
{
    if (probing)
        return;

    probing = true;

    juce::WeakReference<SystemUpdateChannel> weak (this);
    pool.addJob ([weak, this]
    {
        auto found = read();
        juce::MessageManager::callAsync ([weak, this, found = std::move (found)]() mutable
        {
            if (weak == nullptr)
                return;
            probing = false;
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
