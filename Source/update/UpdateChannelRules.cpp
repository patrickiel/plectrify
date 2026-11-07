#include "UpdateChannelRules.h"

namespace plectrify::updatechannel
{

juce::StringArray policyCommand()
{
    return { "env", "LC_ALL=C", "apt-cache", "policy", packageName };
}

juce::String candidateVersionFromPolicy (const juce::String& policyOutput)
{
    juce::StringArray lines;
    lines.addLines (policyOutput);

    for (const auto& raw : lines)
    {
        const auto line = raw.trim();

        if (! line.startsWith ("Candidate:"))
            continue;

        const auto value = line.fromFirstOccurrenceOf (":", false, false).trim();

        // apt prints "(none)" for a package it knows only from dpkg's status
        // and nothing at all for one it has never indexed.
        if (value.isEmpty() || value.startsWithChar ('('))
            return {};

        return value;
    }

    return {};
}

std::vector<SystemUpdater> updatersFor (const juce::String& currentDesktop)
{
    const SystemUpdater softwareUpdater { "update-manager", { "update-manager" } };
    const SystemUpdater gnomeSoftware   { "gnome-software", { "gnome-software", "--mode=updates" } };
    const SystemUpdater discover        { "plasma-discover", { "plasma-discover", "--mode", "update" } };

    juce::StringArray desktops;
    desktops.addTokens (currentDesktop, ":", {});

    for (const auto& desktop : desktops)
        if (desktop.trim().equalsIgnoreCase ("KDE"))
            return { discover, softwareUpdater, gnomeSoftware };

    return { softwareUpdater, gnomeSoftware, discover };
}

std::optional<SystemUpdater> chooseUpdater (const juce::String& currentDesktop,
                                            const std::function<bool (const juce::String&)>& isOnPath)
{
    for (const auto& updater : updatersFor (currentDesktop))
        if (isOnPath (updater.command[0]))
            return updater;

    return std::nullopt;
}

juce::StringArray refreshCommand()
{
    return { "pkexec", "apt-get", "update",
             juce::String ("-o") + "Dir::Etc::SourceList=" + aptSourcesPath,
             "-oDir::Etc::SourceParts=-",
             "-oAPT::Get::List-Cleanup=0" };
}

juce::String refreshOutcome (juce::uint32 exitCode)
{
    if (exitCode == 0)
        return "done";

    if (exitCode == 126)
        return "declined";

    return "failed";
}

} // namespace plectrify::updatechannel
