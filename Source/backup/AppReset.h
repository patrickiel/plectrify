#pragma once

#include <JuceHeader.h>

/**
    Putting Plectrify back the way a fresh installation finds it.

    WHAT A RESET IS. Everything under plectrify::appDataDir() that a player
    made or that the app learned about them: rigs, patches, songs and
    setlists, preferences, the working session, the audio device setup (so the
    next launch makes the first-run device choice and opens the setup wizard
    again), the looper's recordings and the TONE3000 account — its token, its
    window state and the browser profile holding TONE3000's own sign-in cookie.

    WHAT IT IS NOT. Anything outside the per-user root. Plugins installed from
    the Packages panel and downloaded captures live under the machine-wide
    content root and are the user's, exactly as every uninstaller already
    treats them (`pnpm purge --keep-packages` is the shipped behaviour). Inside
    the root it deliberately keeps:

    - known_plugins.xml and scan_in_progress.txt — a cache of what is on this
      disk, plus the crash blacklist. Dropping it would not make the machine
      fresh: the user's plugins are still installed, a settings.json-less
      launch with packages present settles the starter install *without* the
      full rescan (starterBundle.ts), so the drawer would show only the bundled
      NAM until someone pressed Rescan — and a plugin that crashed a scan would
      be loaded again to crash the next one.
    - plugin_folders.json — the folders the user added to the search path,
      which is what the plugins known from them in that cache are there for.
      Forgetting the folders but not the cache left those plugins in the
      drawer with nothing left to remove them by: the folder was no longer
      listed, pruneMissingPlugins drops only files that are gone, and a
      Rescan only adds.
    - The two undo archives (backup-before-restore / backup-before-reset), which
      are the only way back from either operation.
    - WebView2/ and WebView2-Plugin/ — the page's browser profiles. Nothing in
      them is the user's (the theme mirrored into localStorage follows
      settings.json once it loads), and the plugin's may be held open by a DAW
      running right now.
    - crashes/ and the log — diagnostics, which matter most to someone who is
      resetting because something went wrong.

    WHY ON THE NEXT LAUNCH. The running app cannot clear its own data: the
    shell writes audio_settings.xml on the way out, the TONE3000 window writes
    its state when it closes, the page autosaves on a debounce, and a WebView2
    profile cannot be deleted while its browser process holds it. So a reset is
    *scheduled* — a marker beside the data — and then the app relaunches; the
    new process waits for the old one to be gone (Main.cpp) and clears the
    targets before anything has read them. The marker is removed last, so a
    reset interrupted half-way finishes on the following launch rather than
    leaving half an installation behind. It is removed whatever the pass
    achieved, though: a target that refuses to go (a file some other process
    holds) must not turn every future launch into another reset of whatever
    the user has made since. What was left behind is reported to the page
    instead (MainComponent::reportResetLeftovers), with the names, so the user
    can finish by hand rather than be shown a fresh install that is not one.

    WHO ELSE IS USING IT. A Plectrify plugin inside a DAW reads and writes this
    root too, so a reset is refused while one runs (DataRootLease.h): hiding
    the Reset row inside the DAW says nothing about what the standalone may do
    to the DAW's copy.

    THREADING. Message thread, before the main window exists. The targets are
    small apart from the looper's WAVs, and deleting a directory is not a
    pass over its bytes.
*/
namespace plectrify::reset
{

/** The file whose presence means "the next launch resets the data root". */
inline const char* const markerName = "reset_pending";

/** Passed to the relaunched process. It tells the instance check in Main.cpp to
    wait for the instance that scheduled the reset to quit, instead of handing
    its command line to that instance and exiting — which is what a second
    launch of a single-instance app otherwise does. */
inline const char* const relaunchFlag = "--plectrify-after-reset";

/** The one level of undo a reset leaves, written before it is scheduled, in the
    same format and place as the restore's own. */
inline const char* const snapshotName = "backup-before-reset.plectrifybackup";

/** Every name directly under the data root that a reset removes, files and
    directories alike. Named rather than discovered, the same rule the backup
    follows: nothing joins a reset because it appeared beside these. */
const juce::StringArray& targets();

/** Writes the marker. False if it could not be written, in which case nothing
    will happen on the next launch either. */
bool schedule (const juce::File& dataRoot);

/** Removes the marker again — for a relaunch that failed to start. */
void cancel (const juce::File& dataRoot);

bool isScheduled (const juce::File& dataRoot);

/** What a pass over the data root did. */
struct Outcome
{
    bool ran = false;               ///< a reset was scheduled, and this pass was it
    juce::StringArray leftBehind;   ///< targets that would not go
};

/** If a reset is scheduled, removes every target and then the marker; does
    nothing at all otherwise. A target that fails is retried up to `attempts`
    times, `retryDelayMs` apart: the browser processes of the instance that just
    quit can hold the TONE3000 profile for a moment after it has gone. */
Outcome performIfScheduled (const juce::File& dataRoot, int attempts = 1, int retryDelayMs = 0);

} // namespace plectrify::reset
