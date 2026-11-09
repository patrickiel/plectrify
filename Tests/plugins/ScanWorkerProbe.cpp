#include <JuceHeader.h>

#include "PluginScanWorker.h"

#include <iostream>

// A manual spike, deliberately *not* registered with CTest: it launches real
// worker processes that load real third-party plugins.
//
// It drives OutOfProcessPluginScanner exactly as PluginManager's scan thread
// does — one PluginDirectoryScanner per format, the worker killed when each
// is destroyed — over the same files, round after round, and compares every
// round's answer with the first. What it catches is the class of bug a single
// scan hides: a reply still in flight when the worker is torn down, a file
// answered with nothing because the wait ended early, a worker blamed for a
// death that was not its own. The scanner's own log lines ("Plugin scan: …")
// go to stderr.
//
// Usage:
//   PlectrifyScanWorkerProbe <Plectrify executable> <rounds> <plugin file>...
//
// The executable is the app itself: it becomes the worker when launched with
// the worker command line (see PluginScanWorker.h). Exit code 0 when every
// round agreed with the first and nothing was blacklisted.

namespace
{
struct RoundResult
{
    juce::Array<int> countsPerFile;
    juce::StringArray blacklisted;
};

RoundResult runRound (const juce::File& executable,
                      juce::AudioPluginFormatManager& formats,
                      const juce::StringArray& files)
{
    RoundResult result;
    result.countsPerFile.insertMultiple (0, 0, files.size());

    juce::KnownPluginList list;
    list.setCustomScanner (std::make_unique<OutOfProcessPluginScanner> (executable, [] { return false; }));

    for (auto* format : formats.getFormats())
    {
        juce::StringArray forThisFormat;
        for (const auto& file : files)
            if (format->fileMightContainThisPluginType (file))
                forThisFormat.add (file);

        if (forThisFormat.isEmpty())
            continue;

        // The app's arrangement: the scanner's destruction ends the worker.
        juce::PluginDirectoryScanner scanner (list, *format, juce::FileSearchPath(),
                                              /*recursive*/ true, juce::File(), /*allowAsync*/ false);
        scanner.setFilesOrIdentifiersToScan (forThisFormat);

        juce::String name;
        while (scanner.scanNextFile (/*dontRescanIfAlreadyInList*/ false, name)) {}
    }

    for (int i = 0; i < files.size(); ++i)
        for (const auto& type : list.getTypes())
            if (type.fileOrIdentifier == files[i])
                result.countsPerFile.getReference (i)++;

    result.blacklisted = list.getBlacklistedFiles();
    return result;
}

int probe (const juce::File& executable, int rounds, const juce::StringArray& files)
{
    juce::AudioPluginFormatManager formats;
    plectrify::scanworker::addHostedFormats (formats);

    int disagreements = 0;
    RoundResult first;

    for (int round = 1; round <= rounds; ++round)
    {
        const auto started = juce::Time::getMillisecondCounterHiRes();
        auto result = runRound (executable, formats, files);
        const auto ms = juce::roundToInt (juce::Time::getMillisecondCounterHiRes() - started);

        if (round == 1)
            first = result;

        juce::String line = "round " + juce::String (round) + " (" + juce::String (ms) + " ms):";

        for (int i = 0; i < files.size(); ++i)
        {
            const auto count = result.countsPerFile[i];
            line << " " << count;

            if (count != first.countsPerFile[i])
            {
                ++disagreements;
                line << "!";
                std::cerr << "  " << juce::File (files[i]).getFileName() << ": " << count
                          << " plugin(s) in round " << round << ", " << first.countsPerFile[i] << " in round 1\n";
            }
        }

        if (! result.blacklisted.isEmpty())
        {
            ++disagreements;
            line << "  blacklisted: " << result.blacklisted.joinIntoString (", ");
        }

        std::cout << line << "\n" << std::flush;
    }

    std::cout << (disagreements == 0 ? "every round agreed" : juce::String (disagreements) + " disagreement(s)") << "\n";
    return disagreements == 0 ? 0 : 1;
}
}

int main (int argc, char* argv[])
{
    if (argc < 4)
    {
        std::cerr << "usage: PlectrifyScanWorkerProbe <Plectrify executable> <rounds> <plugin file>...\n";
        return 2;
    }

    // The coordinator's ping failure and the Linux child-process reaper both
    // ride the message thread, as they do in the app, so the rounds run on a
    // thread of their own while this one pumps messages.
    juce::ScopedJuceInitialiser_GUI juceInit;

    const juce::File executable (juce::File::getCurrentWorkingDirectory().getChildFile (juce::String (argv[1])));
    const int rounds = juce::String (argv[2]).getIntValue();
    juce::StringArray files;
    for (int i = 3; i < argc; ++i)
        files.add (juce::File::getCurrentWorkingDirectory().getChildFile (juce::String (argv[i])).getFullPathName());

    if (! executable.existsAsFile())
    {
        std::cerr << "no such executable: " << executable.getFullPathName() << "\n";
        return 2;
    }

    std::atomic<int> exitCode { 0 };
    juce::Thread::launch ([&]
    {
        exitCode = probe (executable, rounds, files);
        juce::MessageManager::callAsync ([] { juce::MessageManager::getInstance()->stopDispatchLoop(); });
    });

    juce::MessageManager::getInstance()->runDispatchLoop();
    return exitCode;
}
