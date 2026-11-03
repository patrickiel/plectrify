#include "AppReset.h"

namespace plectrify::reset
{

const juce::StringArray& targets()
{
    static const juce::StringArray names {
        // The player's work — the backup's four sources.
        "settings.json",
        "working-rack.json",
        "rigs",
        "patches",

        // Layouts older builds wrote and the page still migrates on launch: left
        // behind, they would bring the old patches and session straight back
        // (migrateLegacyPatches, and JuceEngine's legacy session adoption).
        "presets",
        "presets.json",
        "lastSession.rig",
        "working-history.json",

        // Session-recovery files, which describe a session that is about to
        // stop existing — a stale sentinel would quarantine nothing, but say
        // the last launch died.
        "restore_in_progress",
        "working-rack.quarantine.json",

        // The audio setup. Its absence is what makes the next launch choose a
        // device for itself (chooseFirstRunAudioDevice); settings.json's is
        // what reopens the setup wizard.
        "audio_settings.xml",

        // The plugin folders the user added to the search path. Like
        // known_plugins.xml this is machine state — paths on this disk — but
        // unlike it, forgetting it costs nothing a rescan would not restore,
        // and a fresh installation searches the standard folders alone.
        "plugin_folders.json",

        // Where the main window was. A fresh installation opens centred.
        "window.json",

        // Recordings.
        "looper-sessions",

        // The TONE3000 account: token, window state, and the browser profile
        // that keeps TONE3000's own sign-in — WebView2's on Windows, the
        // WebKitGTK cookie store on Linux. macOS has no such folder: WKWebView
        // keeps its cookies in the system's per-app store, outside this root,
        // so TONE3000's website may still remember the account there even
        // though Plectrify has forgotten it.
        "tone3000",
        "WebView2-Tone3000",
        "WebKit-Tone3000",
    };

    return names;
}

bool schedule (const juce::File& dataRoot)
{
    if (! dataRoot.createDirectory())
        return false;

    return dataRoot.getChildFile (markerName)
        .replaceWithText (juce::Time::getCurrentTime().toISO8601 (true));
}

void cancel (const juce::File& dataRoot)
{
    dataRoot.getChildFile (markerName).deleteFile();
}

bool isScheduled (const juce::File& dataRoot)
{
    return dataRoot.getChildFile (markerName).existsAsFile();
}

namespace
{
    bool removeEntry (const juce::File& entry)
    {
        if (! entry.exists())
            return true;

        // deleteRecursively follows no links out of the tree, and on a plain
        // file it is deleteFile — one call covers both shapes of target.
        return entry.deleteRecursively() && ! entry.exists();
    }
}

Outcome performIfScheduled (const juce::File& dataRoot, int attempts, int retryDelayMs)
{
    Outcome outcome;

    if (! isScheduled (dataRoot))
        return outcome;

    outcome.ran = true;

    auto pending = targets();
    for (int attempt = 0; attempt < juce::jmax (1, attempts) && ! pending.isEmpty(); ++attempt)
    {
        if (attempt > 0 && retryDelayMs > 0)
            juce::Thread::sleep (retryDelayMs);

        juce::StringArray stillThere;
        for (const auto& name : pending)
            if (! removeEntry (dataRoot.getChildFile (name)))
                stillThere.add (name);

        pending = stillThere;
    }

    outcome.leftBehind = pending;

    // Last, and whatever happened above — see the header.
    cancel (dataRoot);
    return outcome;
}

} // namespace plectrify::reset
