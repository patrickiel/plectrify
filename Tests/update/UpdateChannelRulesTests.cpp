#include <JuceHeader.h>

#include "UpdateChannelRules.h"

#include <iostream>

/*
    The rules behind the Linux update notice's helpers. One of them builds the
    only package-manager command the app ever runs, under pkexec, so it is
    pinned word for word; the rest decide what the notice says, from output
    that apt prints and the page never sees.
*/

namespace
{
    int failures = 0;

    void expect (bool condition, const char* what)
    {
        if (! condition)
        {
            ++failures;
            std::cerr << "FAIL " << what << "\n";
        }
    }

    void expectEquals (const juce::String& actual, const juce::String& expected, const char* what)
    {
        if (actual != expected)
        {
            ++failures;
            std::cerr << "FAIL " << what << " — got \"" << actual << "\", expected \""
                      << expected << "\"\n";
        }
    }

    using namespace plectrify::updatechannel;

    void testCandidate()
    {
        // What apt-cache prints for a package installed from the repository,
        // with the index one release ahead.
        const juce::String ahead =
            "plectrify:\n"
            "  Installed: 0.1.8\n"
            "  Candidate: 0.1.9\n"
            "  Version table:\n"
            "     0.1.9 500\n"
            "        500 https://github.com/patrickiel/plectrify/releases/latest/download ./ Packages\n"
            " *** 0.1.8 100\n"
            "        100 /var/lib/dpkg/status\n";
        expectEquals (candidateVersionFromPolicy (ahead), "0.1.9", "the Candidate line is the answer");

        const juce::String current =
            "plectrify:\n  Installed: 0.1.8\n  Candidate: 0.1.8\n  Version table:\n";
        expectEquals (candidateVersionFromPolicy (current), "0.1.8", "an up-to-date index names the installed version");

        // Installed from a .deb by hand, with no repository at all: dpkg
        // knows it, no index does.
        const juce::String none = "plectrify:\n  Installed: 0.1.8\n  Candidate: (none)\n  Version table:\n";
        expectEquals (candidateVersionFromPolicy (none), "", "(none) is no candidate");

        expectEquals (candidateVersionFromPolicy ({}), "", "no output is no candidate");
        expectEquals (candidateVersionFromPolicy ("N: Unable to locate package plectrify\n"), "",
                      "a package apt has never heard of is no candidate");
        expectEquals (candidateVersionFromPolicy ("  Installed: 0.1.8\n  Candidate:   1.2.3-1ubuntu1  \n"),
                      "1.2.3-1ubuntu1", "the value is trimmed and taken whole");
        // The parse keys on the English label, which is why policyCommand()
        // pins the locale.
        expect (policyCommand().contains ("LC_ALL=C"), "apt-cache runs under LC_ALL=C");
        expectEquals (policyCommand()[0], "env", "…through env, since ChildProcess sets no environment");
        expect (policyCommand().contains ("plectrify"), "and asks about the package the .deb installs");
    }

    void testUpdaters()
    {
        const auto gnome = updatersFor ("ubuntu:GNOME");
        expect (gnome.size() == 3, "three updaters are known");
        expectEquals (gnome[0].id, "update-manager", "Software Updater comes first on GNOME");
        expectEquals (gnome[1].id, "gnome-software", "then GNOME Software");
        expectEquals (gnome[2].id, "plasma-discover", "then Discover");

        const auto kde = updatersFor ("KDE");
        expectEquals (kde[0].id, "plasma-discover", "Discover comes first on KDE");
        expectEquals (updatersFor ("Budgie:kde")[0].id, "plasma-discover", "the match is per token and case-insensitive");
        expectEquals (updatersFor ({})[0].id, "update-manager", "no desktop named is the GNOME order");

        for (const auto& updater : gnome)
        {
            expect (updater.command.size() >= 1, "every updater has an executable");
            expectEquals (updater.command[0], updater.id, "its id is its executable's name");
        }

        expect (gnome[1].command.contains ("--mode=updates"), "GNOME Software opens on its updates page");
        expect (kde[0].command.contains ("--mode") && kde[0].command.contains ("update"), "Discover opens on its updates page");

        const auto onlyGnomeSoftware = [] (const juce::String& name) { return name == "gnome-software"; };
        const auto chosen = chooseUpdater ("ubuntu:GNOME", onlyGnomeSoftware);
        expect (chosen.has_value() && chosen->id == "gnome-software", "the first updater on PATH is chosen");
        expect (! chooseUpdater ("ubuntu:GNOME", [] (const juce::String&) { return false; }).has_value(),
                "none on PATH is none");
    }

    void testRefresh()
    {
        const auto command = refreshCommand();
        expectEquals (command[0], "pkexec", "the refresh runs under pkexec");
        expectEquals (command[1], "apt-get", "…and is apt-get");
        expectEquals (command[2], "update", "…update");
        expect (command.contains (juce::String ("-oDir::Etc::SourceList=") + aptSourcesPath),
                "scoped to the .deb's own sources file");
        expect (command.contains ("-oDir::Etc::SourceParts=-"), "with sources.list.d disabled");
        expect (command.contains ("-oAPT::Get::List-Cleanup=0"),
                "and the clean-up off, or every other repository's index is deleted");
        expect (! command.contains ("install") && ! command.contains ("upgrade"),
                "it never installs anything");
        expectEquals (aptSourcesPath, "/etc/apt/sources.list.d/plectrify.sources",
                      "the sources path is scripts/aptRepository.ts's APT_SOURCES_PATH");

        expectEquals (refreshOutcome (0), "done", "exit 0 is done");
        expectEquals (refreshOutcome (126), "declined", "126 is the prompt dismissed");
        expectEquals (refreshOutcome (127), "failed", "127 is pkexec refusing");
        expectEquals (refreshOutcome (100), "failed", "100 is apt-get failing to fetch");
        expectEquals (refreshOutcome (1), "failed", "anything else failed");
    }
}

int main()
{
    testCandidate();
    testUpdaters();
    testRefresh();

    if (failures == 0)
        std::cout << "UpdateChannel tests passed\n";

    return failures;
}
