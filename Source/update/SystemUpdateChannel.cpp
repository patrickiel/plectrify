#include "SystemUpdateChannel.h"

#include "DetachedProcess.h"

#if JUCE_LINUX
 #include <cerrno>
 #include <cstring>
 #include <fcntl.h>
 #include <signal.h>
 #include <spawn.h>
 #include <string>
 #include <sys/wait.h>
 #include <unistd.h>
 #include <vector>

extern char** environ;
#endif

namespace plectrify
{

namespace
{
   #if JUCE_LINUX
    // apt-cache reads a local cache; this is a hung machine, not a slow one.
    constexpr int policyTimeoutMs = 15'000;
    // The password prompt can sit for as long as the user leaves it, and
    // past authentication the process is root's and cannot be ended from
    // here anyway (see runToCompletion), so a refresh has no deadline of its
    // own: pkexec with no agent exits at once, a dismissed prompt exits 126,
    // and apt's own fetch timeouts end a dead host. Nothing is left that a
    // deadline would catch, and one that fired under an open prompt reported
    // a failure the user then turned into a success nobody learnt of.
    constexpr int refreshTimeoutMs = 0;

    /** `name` resolved against PATH, or a non-existent File. Only absolute
        entries are searched: a relative one (`.`, `bin`) names a different
        place from every working directory, which is nothing to run pkexec
        from — and juce::File asserts on one. */
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

    /** Runs `command` to completion and reports its exit code; `output`
        collects stdout when `captureOutput`. Returns false on a process that
        could not start, that died from a signal, or that outlived `timeoutMs`
        (and was killed) — and on the pool job it runs in being told to stop,
        when the process is left running: the one that matters is pkexec,
        whose prompt would be orphaned by a kill, and the shell's destructor
        is what asks.

        Not juce::ChildProcess, which has no word for a child that died from a
        signal: its exit code for one is 0, so an apt-get killed mid-run read
        as a refresh that succeeded and found nothing — the one outcome that
        tells the user to reinstall. The wait status is read here instead.

        The deadline bounds a hang, not a process this app cannot end: once
        pkexec has authenticated it runs as root, kill() fails with EPERM,
        and the process is then waited out — it is still this app's child,
        its answer is still coming, and apt's own fetch timeouts end it. A
        deadline of 0 is no deadline.

        The wait is sliced so the job can honour being stopped: a job the
        pool cannot stop is killed by force (pthread_cancel) at shutdown, and
        the forced unwind through the pool's catch-all aborts the process.
        Output is drained in the same slices, so a child that prints more
        than the pipe holds cannot deadlock against a parent that only waits. */
    bool runToCompletion (const juce::StringArray& command, int timeoutMs, bool captureOutput,
                          juce::String& output, juce::uint32& exitCode)
    {
        std::vector<std::string> args;
        for (const auto& argument : command)
            args.push_back (argument.toStdString());

        std::vector<char*> argv;
        for (auto& argument : args)
            argv.push_back (const_cast<char*> (argument.c_str()));
        argv.push_back (nullptr);

        int pipeFds[2] { -1, -1 };
        if (captureOutput && ::pipe2 (pipeFds, O_CLOEXEC) != 0)
            return false;

        // Non-blocking on the read end alone — a flag set at pipe2 rides the
        // open file description onto the child's stdout, where a print
        // larger than the pipe would then fail with EAGAIN between drains.
        if (captureOutput)
            ::fcntl (pipeFds[0], F_SETFL, ::fcntl (pipeFds[0], F_GETFL) | O_NONBLOCK);

        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init (&actions);

        if (captureOutput)
        {
            posix_spawn_file_actions_adddup2 (&actions, pipeFds[1], STDOUT_FILENO);
        }
        else
        {
            posix_spawn_file_actions_addopen (&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
        }

       #if defined (__GLIBC__) && __GLIBC_PREREQ (2, 34)
        // Nothing of this process's — the audio device above all — rides into
        // apt-get or a prompt that may sit for minutes (DetachedProcess.h).
        posix_spawn_file_actions_addclosefrom_np (&actions, 3);
       #endif

        pid_t pid = 0;
        const auto spawned = ::posix_spawnp (&pid, argv[0], &actions, nullptr, argv.data(), environ);
        posix_spawn_file_actions_destroy (&actions);

        if (captureOutput)
            ::close (pipeFds[1]);

        if (spawned != 0)
        {
            if (captureOutput)
                ::close (pipeFds[0]);
            return false;
        }

        juce::MemoryOutputStream collected;
        const auto drain = [&]
        {
            if (! captureOutput || pipeFds[0] < 0)
                return;

            char buffer[4096];
            for (;;)
            {
                const auto got = ::read (pipeFds[0], buffer, sizeof (buffer));
                if (got > 0)
                {
                    collected.write (buffer, (size_t) got);
                    continue;
                }
                if (got < 0 && errno == EINTR)
                    continue;
                // EOF, or nothing more yet (EAGAIN): either way, later.
                break;
            }
        };

        const auto* job = juce::ThreadPoolJob::getCurrentThreadPoolJob();
        auto deadline = timeoutMs > 0 ? juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs : 0u;
        bool killed = false;

        int status = 0;
        for (;;)
        {
            drain();

            const auto reaped = ::waitpid (pid, &status, WNOHANG);
            if (reaped == pid)
                break;

            if (reaped < 0 && errno != EINTR)
            {
                // Lost track of the child; nothing honest can be said about it.
                if (captureOutput)
                    ::close (pipeFds[0]);
                return false;
            }

            if (job != nullptr && job->shouldExit())
            {
                if (captureOutput)
                    ::close (pipeFds[0]);
                return false;
            }

            if (deadline != 0 && juce::Time::getMillisecondCounter() >= deadline)
            {
                if (::kill (pid, SIGKILL) == 0)
                {
                    killed = true;
                }
                else
                {
                    juce::Logger::writeToLog ("Update channel: " + command[0]
                                              + " outlived its deadline and cannot be killed ("
                                              + juce::String (strerror (errno)) + "); waiting for it");
                }
                // Killed or not, the end is now the wait status: a killed child
                // reads as signalled below, an unkillable one is waited out.
                deadline = 0;
            }

            juce::Thread::sleep (100);
        }

        drain();
        if (captureOutput)
        {
            ::close (pipeFds[0]);
            output = collected.toString();
        }

        if (killed || ! WIFEXITED (status))
            return false;

        exitCode = (juce::uint32) WEXITSTATUS (status);
        return true;
    }
   #endif
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
    // A refresh ends with a probe of its own, so none is owed; but the page
    // that asked may be one reloaded mid-refresh, and what it is owed is the
    // state it missed. A probe already queued answers for this one.
    if (refreshing)
    {
        publish (state);
        return;
    }

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
            // A probe never reports a refresh: keep the last outcome on the
            // state so the page's wording survives a re-probe — including
            // `refreshing`, for a refresh queued behind this probe.
            found.refresh = state.refresh;
            probing = false;
            publish (std::move (found));
        });
    });
}

void SystemUpdateChannel::refresh()
{
    if (refreshing)
        return;

    refreshing = true;

    State begun = state;
    begun.refresh = "refreshing";
    publish (begun);

    // The pool has one thread, so a probe in flight finishes first and this
    // runs behind it rather than being dropped — the notice asks for a probe
    // the moment it shows, which is also the moment Refresh becomes clickable.
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
            refreshing = false;
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
