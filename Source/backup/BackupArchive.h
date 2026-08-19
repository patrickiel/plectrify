#pragma once

#include <JuceHeader.h>

/**
    The user's work, in and out of one file.

    Everything a player makes lives under plectrify::appDataDir() and, until
    this, had no way out of it: no export, no import, and no file dialog
    anywhere in the application. A new machine, a reinstall, or a second
    computer meant knowing where that folder is and copying it by hand — and a
    purge, an uninstall or a mistaken "New rig" destroyed it with no undo.

    A backup is a plain zip, named *.plectrifybackup so any zip tool opens it:

        plectrify-backup.json      the manifest below
        settings.json              preferences, songs, setlists, MIDI bindings
        working-rack.json          the rack that was playing
        rigs/index.json
        rigs/<slug>-<id>.rig
        patches/<id>.patch

    WHAT IS NOT IN IT, AND WHY. writeArchive names those four sources
    explicitly rather than walking the data root, so nothing can be swept in by
    a folder appearing beside them later. Deliberately absent:

    - tone3000/ — credentials.json holds a bearer token. The web page is
      refused that whole subtree (PlectrifyEngine::resolveAppFile); a backup
      built natively *could* reach it and must not.
    - audio_settings.xml — device state, not work. Restoring another machine's
      copy points the app at hardware that is not there, and its mere presence
      is what tells chooseFirstRunAudioDevice (AudioSetupRules.h) that this is
      not a first run — so a restored machine would skip the ASIO-preferring
      choice and land on shared-mode WASAPI on the built-in microphone, which
      is the exact first impression that rule exists to prevent.
    - known_plugins.xml — a scan cache naming this machine's plugin paths.
    - looper-sessions/, crashes/, the WebView2 profiles — bulk, and none of it
      is the user's work.

    Installed plugins and downloaded TONE3000 captures are not here either:
    they are payload the Packages panel and TONE3000 fetch again, not something
    Plectrify may redistribute through a file the user carries around.

    THREADING. Everything here runs on the message thread and blocks it. That
    is deliberate and only defensible because the payload is JSON text measured
    in hundreds of kilobytes — the operation is over well inside a frame. If
    looper WAVs, captures or anything else measured in megabytes ever joins the
    archive, this has to move to a background thread with a progress stream,
    the shape CatalogueInstaller already uses for a download.
*/
namespace plectrify::backup
{

/** The zip entry holding the manifest, and the extension a backup carries. */
inline const char* const manifestEntryName = "plectrify-backup.json";
inline const char* const fileExtension     = ".plectrifybackup";
inline const char* const fileWildcard      = "*.plectrifybackup";

/** The manifest's `format`, and the highest `formatVersion` this build can
    read. A document that is not this format, or that claims a version above
    this one, is refused whole rather than field by field — the same reasoning
    as the catalogue's schemaVersion gate in Catalogue.cpp: a build too old to
    understand the shape must say so plainly instead of restoring half of it. */
inline const char* const formatName    = "plectrify-backup";
inline constexpr int     formatVersion = 1;

/** The archive's own description of itself. */
struct Manifest
{
    int           formatVersion = 0;
    juce::String  appVersion;   ///< the Plectrify that wrote it
    juce::String  platform;     ///< catalogueRuntimePlatform, e.g. "windows-x64"
    juce::String  createdAt;    ///< ISO-8601, UTC
    int           rigs    = 0;
    int           patches = 0;
};

/** What an operation did, for the page's status line and dialogs. `path` is
    the file written or read; `error` is empty exactly when `ok`.

    `error` is a short token, never a sentence: the wording lives beside the
    rest of the panel's copy in describeBackupError (ui/src/lib/engine/backup.ts),
    the same split the catalogue's install errors use. One of "empty", "write",
    "save", "notBackup", "newerFormat", "dataRoot" or "damaged". */
struct Result
{
    bool         ok = false;
    juce::String error;
    juce::File   path;
    int          rigs     = 0;
    int          patches  = 0;
    juce::String platform; ///< the archive's, so a cross-OS restore can say so
};

//==============================================================================
// Pure rules — no filesystem, covered by Tests/backup/BackupArchiveTests.cpp.

/** The name a save dialog opens on: "Plectrify backup 2026-08-19.plectrifybackup".
    Dated rather than timestamped — a player who takes two backups in one day
    is replacing the morning's, and the dialog's overwrite warning says so
    better than a filename nobody reads. */
juce::String defaultBackupFileName (juce::Time now);

/** Whether a zip entry may be extracted into the data root.

    Calls isSafeArchiveEntryName (Catalogue.h) first — the traversal, drive
    letter and UNC gate CatalogueInstaller already puts over juce::ZipFile —
    and then narrows to this format's own shape: the manifest, settings.json,
    working-rack.json, or exactly one file directly inside rigs/ or patches/.
    No deeper nesting, no dotfiles, no directory entries, nothing else at all.

    An allow-list rather than a deny-list because the destination is the web
    page's file sandbox: an entry named tone3000/credentials.json would
    otherwise write a token nothing else can reach, and one named
    audio_settings.xml would point this machine at another's soundcard. */
bool isBackupEntryName (const juce::String& entryName);

/** The manifest document for an archive holding these counts.

    `appVersion` is passed in rather than read from
    JUCE_APPLICATION_VERSION_STRING: that macro is defined per target, so a
    function reaching for it could not be linked into a console test at all.
    Recording what a caller hands over is also the honest shape for a pure
    function. */
juce::var buildManifest (int rigs, int patches, const juce::String& appVersion, juce::Time now);

/** Reads a manifest, or returns false: wrong `format`, a `formatVersion` this
    build does not know, or anything that is not an object at all. */
bool parseManifest (const juce::var& document, Manifest& out);

//==============================================================================
// The I/O.

/** Writes the four sources under `dataRoot` into `destination`.

    Through a juce::TemporaryFile, so a failure or a full disk never leaves a
    truncated archive at a path the user will later trust — the same care
    LooperSessionStore::writeWav takes with a recording. */
Result writeArchive (const juce::File& destination, const juce::File& dataRoot,
                     const juce::String& appVersion);

/** Replaces `dataRoot`'s rigs, patches, working session and settings with
    `source`'s.

    The manifest is read and accepted BEFORE anything is deleted, so a file
    that is not a Plectrify backup — or is one from a newer build — costs the
    user nothing. What is then cleared is only what this format writes, plus
    the two session-recovery files: a stale `restore_in_progress` means "the
    last launch died applying the working rack" and would quarantine the
    freshly restored session on the very next boot. */
Result readArchive (const juce::File& source, const juce::File& dataRoot);

} // namespace plectrify::backup
