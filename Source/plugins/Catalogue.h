#pragma once

#include <JuceHeader.h>

#include <map>
#include <optional>
#include <vector>

/**
    The plugin catalogue: which plugins Plectrify offers to download, which bundles
    group them, and the pure logic that decides whether a given catalogue may
    be trusted.

    Everything here is free functions over strings and buffers — no network, no
    threads, no filesystem beyond what a caller hands in — so the security-
    critical parts (signature verification, archive-entry safety) are covered
    by offline unit tests. CatalogueInstaller owns the I/O.

    The catalogue is fetched from the server at runtime, so publishing a plugin
    update needs no Plectrify release. Debug builds instead read
    packaging/catalogue.json straight from the source tree
    (PLECTRIFY_CATALOGUE_FILE), which is the whole dev loop: edit the JSON,
    restart. Nothing is compiled into the binary.

    THE MANIFEST IS A TRUST ROOT. Each package carries a SHA-256 that
    authorises a DLL to be installed into the plugin scan path and loaded into
    this process. Release builds fetch that manifest over the network, so it is
    signed and verification is mandatory: never parse bytes that
    verifyManifestSignature() rejected, not even to display a name.

    Two fields on a package look alike and are not: `kind` decides whether the
    payload is executed, `category` decides only which heading it appears under.
    Keep display code away from the first and install code away from the second.
*/

/** What a package *is*, which decides where it lands and how far it is
    trusted. This is the security-bearing half of a package definition.

    A `plugin` is unzipped into the VST3 scan path and will be loaded into this
    process; `content` unpacks into a plain data folder and is never loaded as
    code. It is an explicit field, never inferred from a category or from which
    other fields happen to be present, so that no amount of editing the
    catalogue's display text can move a payload into the load path.

    An unrecognised value is not a parse detail to be defaulted away — see
    parseCatalogueManifest, which rejects the whole catalogue. */
enum class PackageKind
{
    plugin,
    content
};

/** The platform slug this build downloads assets for, as used in the keys of
    a package's `assets` block. One constant rather than a runtime lookup so
    the compiler proves every build has exactly one answer. */
#if JUCE_MAC
inline const char* const catalogueRuntimePlatform = "macos-arm64";
#else
inline const char* const catalogueRuntimePlatform = "windows-x64";
#endif

/** One platform's downloadable payload of a package: where to get it, how to
    verify it, and (optionally) what to extract from it.

    Every payload is one of these, this build's own included — there is no
    privileged platform and no fallback between them. Windows was privileged
    until schemaVersion 4 (flat assetUrl/sha256/downloadBytes fields on the
    package, with `assets` holding only the others), which meant every reader
    had two paths to the same answer. */
struct CatalogueAsset
{
    juce::String url;          // https only
    juce::String sha256;       // lowercase hex, 64 chars
    juce::int64 downloadBytes = 0;
    /** Archive entries to extract. Empty means: use the package's own
        `include` — per-platform archives usually differ in layout, but a
        pack whose patterns are layout-neutral needn't repeat them. */
    juce::StringArray include;
    /** Plectrify serves these bytes rather than the project's own release page
        doing it, which is what makes Plectrify their distributor.

        Per asset because it is a fact about this one url: a package may be a
        mirror on one platform and a re-host on the other, and the panel should
        say which of those the user in front of it is being offered. Display
        only here — nothing about how a payload is fetched, verified or
        installed reads it. */
    bool selfHosted = false;

    bool isValid (const juce::String& what, juce::String& reasonOut) const;
};

/** One downloadable package, plugin or content. Mirrors an entry of `packages`
    in packaging/catalogue.json.

    Plugins and IR packs were two structs until they turned out to differ in
    exactly two ways — where the payload lands and whether it is code — both of
    which `kind` now carries. */
struct CataloguePackage
{
    juce::String id;          // stable key; names the install marker
    PackageKind kind = PackageKind::plugin;
    /** Where the Packages panel files this package, outermost heading first:
        {"Effects"} is one section, {"Effects", "Reverb"} a subsection inside
        it. Grouped by and printed verbatim at every level; empty means
        uncategorised.

        A path rather than one heading because a flat list can only be
        subdivided by inventing longer names ("Effects", then "Effects —
        reverb"), which hides the nesting in text nothing can read. Nesting is
        display and nothing else: this is still cosmetic only, and still never
        consulted when deciding where a payload is installed. */
    juce::StringArray category;
    juce::String name;        // shown in the Packages panel
    juce::String purpose;     // one line, shown under the name
    juce::String version;     // drives the update check
    juce::String licenseId;   // SPDX id of the BINARY, not the repo headline
    juce::String licenseUrl;
    juce::String projectUrl;
    juce::String sourceUrl;   // corresponding source, when we convey copyleft
    juce::String minAppVersion; // optional; empty means no floor
    /// Archive entries to extract, shared by every platform. An asset may name
    /// its own instead; most need not, because the patterns that matter here
    /// ("**/*.vst3/**") are layout-neutral.
    juce::StringArray include;
    /** kind == content only: the folder under the machine-wide content root
        (%PROGRAMDATA%/Plectrify on Windows, /Users/Shared/Plectrify on macOS)
        this unpacks into, e.g. "irs". A plain name — it is joined to a path,
        so it may not escape. Empty for a plugin, which always installs into
        the managed VST3 directory. */
    juce::String installDir;
    /** kind == content only: keep the archive's own folder structure instead of
        unpacking flat.

        Flat is the default because an IR or capture browser wants one folder of
        files and does not care how upstream nested them. A patch pack is the
        exception: a patch that carries its own assets is a folder — the patch
        beside the files it loads — and flattening it would both collide names
        across packs and lose which asset belongs to which patch.

        This decides layout, never trust: the payload still lands under
        `installDir` and is still never loaded as code, and every archive entry
        still passes `isSafeArchiveEntryName`, so nothing here can place a file
        outside the content folder. */
    bool preserveStructure = false;
    /** The one package this one needs to be of any use, installed before it.
        Empty for a package that stands on its own, which is most of them.

        The edge points from the thing that needs something to the thing it
        needs — a patch names the plugin it was built for, never a plugin the
        patches that happen to exist for it. That is the only direction that can
        be stated truthfully (a JTM45 patch is worthless without Neural Amp
        Modeler; Neural Amp Modeler is a fine plugin with no patches at all),
        and it is what lets a patch be added, revised or dropped without
        touching the plugin's entry, its pin or its provenance.

        One dependency rather than a list, because it answers "what is this
        for?" — a question with one answer. A package that genuinely needed two
        unrelated things would be two packages. A chain is still followed to its
        end, so a dependency may itself depend on something.

        It must name a package in this same catalogue and may not name itself:
        parsing rejects both. Beyond that the edge is unrestricted — content
        naming a plugin is the patch case exactly — because it can only pull in
        something the catalogue already offers on a row of its own, with its own
        kind, hash and destination. A dependency decides what gets installed,
        never what any of it *is* or where it lands. */
    juce::String dependsOn;

    /** Every platform's payload, keyed by slug ("windows-x64",
        "macos-arm64"). At least one, or the package is offered nowhere and
        parsing rejects it. Absence of a build's own slug means the package is
        not offered on that platform — the panel shows the row greyed rather
        than hiding it, and the installer refuses it.

        A slug this build does not know is kept rather than refused: it is a
        platform someone else's build serves, and dropping it here would make
        adding one a schema change. */
    std::map<juce::String, CatalogueAsset> assets;

    bool isContent() const { return kind == PackageKind::content; }

    /** The payload `platformSlug` should download, or nullopt when the
        package is not offered for it — one map lookup, with no platform
        special-cased. An asset with no `include` of its own inherits the
        package's. Callers pass catalogueRuntimePlatform; the parameter exists
        so both platforms' behaviour is testable everywhere. */
    std::optional<CatalogueAsset> assetFor (const juce::String& platformSlug) const;

    bool isValid (juce::String& reasonOut) const;
};

/** A named bundle - "Starter bundle" and whatever follows it. Holds only IDs, so
    a bundle can gain or lose members without touching a single package
    definition, and two bundles can share one.

    `version` is the bundle's own, independent of the packages it names: it is how
    we know which edition a user installed, so bump it whenever `packageIds`
    changes. A package getting a new version does not change the bundle. */
struct CatalogueBundle
{
    juce::String id, name, description, version;
    juce::StringArray packageIds;

    bool isValid (juce::String& reasonOut) const;
};

/** The whole catalogue: package definitions plus the bundles that group them. */
struct Catalogue
{
    /** Monotonically increasing signed-manifest revision. A release build will
        not replace an accepted catalogue with a lower revision, even when the
        older bytes still carry a valid signature. */
    juce::int64 revision = 0;
    std::vector<CataloguePackage> packages;
    std::vector<CatalogueBundle> bundles;
};

/** Expands requested package ids into the order they must be installed in:
    each package's dependency chain ahead of the package that named it, every id
    once however many times it is reached, and ids this catalogue does not
    define dropped.

    One definition, called by the installer rather than by each caller, so that
    "install this" means the same thing whether it came from a row, a bundle or
    a future caller — a patch installed without the plugin it names is not a
    partial success, it is a patch that cannot be applied.

    Cycle-safe: a chain stops when it revisits a package, so a catalogue with a
    dependency loop installs each of its members once instead of hanging.
    `validate` is what refuses to publish one. */
juce::StringArray resolveInstallOrder (const Catalogue& catalogue,
                                       const juce::StringArray& requested);

/** Where a catalogue came from. Surfaced in the panel so a stale list is never
    mistaken for the current one — and so a developer can see they are on the
    source-tree file. */
enum class CatalogueSource
{
    none,       // nothing usable — offline with no cache yet
    devLocal,   // Debug only: packaging/catalogue.json, UNSIGNED
    remote,     // fetched and signature-verified
    cache       // last verified manifest, re-verified on load
};

juce::String toString (CatalogueSource);

/** The highest schemaVersion this build understands. A manifest declaring more
    is rejected wholesale rather than partially parsed: a future field this
    build silently ignores could change what a plugin or bundle means.

    Which is also why `category` gaining its array form did NOT bump this. The
    test is what an older build gets wrong, not whether the format changed: a
    build that reads {"Effects", "Reverb"} as one unreadable string files those
    rows under "More downloads" and installs every one of them correctly, while
    a bump would leave that same build with no catalogue at all. Bump it for a
    field that changes what a package *is* — never for one the schema itself
    calls cosmetic.

    4 moved every payload into `assets`, keyed by platform, and removed the flat
    Windows fields. That one meets the test: a version-3 build reading it finds
    no assetUrl on any package and could only conclude the catalogue is broken,
    so it is told to reject the whole thing and keep the copy it has. */
inline constexpr int catalogueSchemaVersion = 4;

/** Licence disclosure shown in the Packages panel. Carried by the catalogue
    rather than compiled in or shipped as a file, so that changing the offered
    plugins changes their notices in the same step — a stale notice on disk
    would describe plugins that are no longer on offer. Free-form: the panel
    renders whichever fields are present. */
struct CatalogueNotices
{
    juce::String summary, fetched, hosted, models, uninstall;

    bool isEmpty() const
    {
        return summary.isEmpty() && fetched.isEmpty() && hosted.isEmpty()
            && models.isEmpty() && uninstall.isEmpty();
    }
};

/** Reads the manifest's `notices` block. Absent fields come back empty. */
CatalogueNotices parseCatalogueNotices (const juce::String& json);

/** Where to get something Plectrify does not host — amp captures, IRs, and in
    time plugins we cannot redistribute. Plectrify bundles none of it (see the
    catalogue's own comment for why), so pointing at the source is the whole
    answer, and carrying the links in the catalogue means a moved link is a
    publish rather than a release.

    `category` is the panel's section path — the same shape and the same rules
    as a package's, since both lists are grouped by the one function. It travels
    as data for the same reason the links do: offering a new kind of download
    must not need a UI change. Empty means uncategorised, which the panel
    gathers into one trailing group. */
struct CatalogueLink
{
    juce::StringArray category;
    juce::String label, url, note;
};

std::vector<CatalogueLink> parseCatalogueLinks (const juce::String& json);

/** Parses and validates a manifest. Returns an empty catalogue and sets
    `errorOut` on malformed JSON, an unknown schemaVersion, any entry failing
    isValid(), or a bundle naming a plugin that does not exist — a catalogue is
    all-or-nothing, because a half-parsed one would offer a subset while
    looking complete. Never throws. */
Catalogue parseCatalogueManifest (const juce::String& json, juce::String& errorOut);

/** Whether adopting `candidateRevision` would roll back a catalogue already
    accepted at `acceptedRevision`. Equality is allowed: a refresh commonly
    receives the same immutable revision again. */
bool isCatalogueRevisionRollback (juce::int64 candidateRevision,
                                  juce::int64 acceptedRevision) noexcept;

/** Lowercase hex SHA-256 of a buffer. */
juce::String sha256Hex (const void* data, size_t numBytes);

/** Verifies a detached signature over `manifestBytes`.

    The scheme is JUCE-native: the signer applies its private key to the
    SHA-256 digest read as a big integer, and this applies the public key to
    recover it. `signatureHex` is that big integer in hex.

    Returns false on any malformed input. A false return means the bytes are
    unauthenticated and must not be parsed. */
bool verifyManifestSignature (const void* manifestBytes,
                              size_t numBytes,
                              const juce::String& signatureHex,
                              const juce::RSAKey& publicKey);

/** The public key release builds verify against. Empty until a keypair is
    generated (see RELEASING.md) — and while it is empty, remote catalogues are
    refused outright rather than trusted, so an unsigned build shows no
    catalogue instead of silently accepting whatever the network returned. */
juce::RSAKey catalogueSigningKey();

/** Glob matcher for a plugin's `include` patterns. Supports `*` (matches
    within one path segment) and `**` (matches across separators). Paths use
    forward slashes, as zip entries do. */
bool matchesIncludePattern (const juce::String& path, const juce::String& pattern);

bool matchesAnyIncludePattern (const juce::String& path, const juce::StringArray& patterns);

/** Whether a zip entry name may be extracted. Rejects absolute paths, drive
    letters, UNC prefixes, and any `..` segment.

    juce::ZipFile already refuses to write outside the target directory; this
    is a second, explicit gate so the rule is visible and tested here rather
    than resting on a library implementation detail. */
bool isSafeArchiveEntryName (const juce::String& entryName);

/** Whether a symlink archive entry may be recreated with this target. macOS
    VST3 bundles arrive as zips that can carry symlinks, and juce::ZipFile
    recreates one with whatever target the archive names — including an
    absolute path or a `..` escape, which entry-name checking never sees
    (the target is the entry's *content*). Same rules as an entry name, so a
    link can only point at something extracted beside it. */
bool isSafeSymlinkTarget (const juce::String& target);

/** Whether a zip entry's external file attributes describe an executable file.

    juce::ZipFile writes every regular entry through a FileOutputStream, which
    creates it 0644 and never looks at these bits — so without this a macOS
    bundle's Mach-O arrives with no +x and the plugin cannot load, however
    intact the rest of the bundle is.

    The high 16 bits are the `st_mode` a POSIX zipper recorded; an archive
    written on Windows leaves them zero, which reads as "not executable" and is
    the right answer there. Only regular files qualify: a directory needs +x
    already and gets it from createDirectory, and a symlink must be left alone
    entirely, since chmod follows one and would change the permissions of
    whatever it points at. A mode with no file type at all is taken at its
    word — some zippers write one that way. */
bool archiveEntryIsExecutable (juce::uint32 externalFileAttributes);

/** Whether `relativePath` names a plugin to install, rather than a file living
    inside one.

    A Windows VST3 is a bundle *directory* — "Foo.vst3/Contents/x86_64-win/
    Foo.vst3" — so the name appears twice, once for the bundle and once for the
    DLL inside it. Only the outermost is a plugin; installing the inner file
    too would put a bare, non-functional copy beside the real bundle. True only
    when no ancestor component already ends in .vst3. */
bool isOutermostPluginPath (const juce::String& relativePath);

/** Whether an install marker's recorded file name may be deleted on uninstall.

    Uninstall is the one operation that deletes on the strength of a file we
    wrote earlier, so it refuses anything that is not a plain name directly
    inside the managed plugin folder: no separators, no `..`, no drive letter.
    A corrupted or hand-edited marker then removes nothing rather than reaching
    outside the directory Plectrify owns. */
bool isSafeInstalledFileName (const juce::String& fileName);

/** Whether an install marker may use `recordedPath` as the root of recursive
    deletes. Plugins may name the exact managed directory; content markers may
    additionally name an ordinary direct child of `contentParentDirectory` —
    the machine-wide Plectrify content root, passed in explicitly because the
    two roots are related differently per OS (on Windows the content root is
    the plugin directory's parent; on macOS the plugin directory is per-user
    while content lives under /Users/Shared/Plectrify). Passing it also keeps
    this pure and both shapes testable everywhere. */
bool isApprovedInstallMarkerDirectory (const juce::String& recordedPath,
                                       const juce::File& managedPluginDirectory,
                                       const juce::File& contentParentDirectory,
                                       bool contentMarker);

/** Identifies whatever is at an installed path right now, so a later install
    or uninstall can tell Plectrify's own copy from one somebody else has put
    there since.

    The marker's file names alone cannot answer that. On macOS the managed
    plugin directory is the user's own ~/Library/Audio/Plug-Ins/VST3 — the
    convention every other VST3 installer writes to as well — so a "Foo.vst3"
    beside our marker may be a vendor's build that replaced ours, and deleting
    it to make room for a download would destroy a plugin Plectrify never
    installed. Recorded at install time and re-checked before anything is
    replaced or removed.

    Cheap and content-free: the hash covers each entry's relative path and
    size, never its bytes, so fingerprinting a bundle costs a stat per file
    rather than a full read. That distinguishes a different build put in its
    place, which is the whole question here; it is not a tamper check, and
    does not pretend to be one — the signed manifest and the asset's pinned
    SHA-256 are what decide whether bytes may be installed at all.

    Symbolic links are recorded but never followed: a macOS framework inside a
    bundle points Versions/Current at a sibling, so following links would count
    the same files twice and, given a cycle, never finish. Hidden entries are
    skipped at every depth, so a .DS_Store that Finder drops inside a bundle
    does not make Plectrify disown it.

    Returns an empty string when nothing is at that path. */
juce::String installedFileFingerprint (const juce::File& installedPath);

/** Whether Plectrify may replace what is already sitting at a managed plugin
    path it is about to install over.

    `nameIsClaimed` is whether an install marker accounts for that name at all,
    `claimedFingerprint` what it recorded (empty for a record written before
    fingerprints existed, and for the claim an in-flight install writes before
    it moves anything), and `fingerprintNow` what is actually there.

    `directoryIsExclusive` is the one thing that makes an *unclaimed* name
    answerable at all, and it differs per OS. On Windows the managed directory
    is %PROGRAMDATA%/Plectrify/plugins — Plectrify's own folder, which nothing
    else writes to — so a bundle there that no marker accounts for is debris
    from an install of ours that was interrupted between moving the file and
    recording it, and taking it over is the only way that name is ever
    installable again. On macOS the same directory is the user's own
    ~/Library/Audio/Plug-Ins/VST3, shared with every other VST3 installer, so an
    unclaimed Foo.vst3 may be a vendor's build and replacing it would destroy a
    plugin Plectrify never installed and cannot put back.

    A *claimed* name whose fingerprint no longer matches is refused on both,
    exclusive folder or not: something replaced our copy after we wrote it, and
    the marker is there to be removed if the user wants Plectrify to manage the
    name again. */
bool mayReplaceManagedPlugin (bool nameIsClaimed,
                              const juce::String& claimedFingerprint,
                              const juce::String& fingerprintNow,
                              bool directoryIsExclusive);

/** The same question on the way out: whether Plectrify may delete a file its own
    marker names, given that the file is no longer what it recorded.

    `recordedFingerprint` is empty for a record written before fingerprints
    existed and for content, which carries none — those are removed by name as
    they always were.

    A match is removed on both platforms. A mismatch splits the same way
    mayReplaceManagedPlugin() does, and for the same reason: on macOS the
    managed directory is the user's shared ~/Library/Audio/Plug-Ins/VST3, so a
    bundle that changed after we wrote it is very likely a vendor's own
    installer having taken the name over, and Plectrify drops its claim and
    leaves the file rather than deleting a plugin it did not install. On Windows
    the directory is %PROGRAMDATA%/Plectrify/plugins, which nothing else writes
    to, so there is nobody else it could belong to — and leaving it is not
    neutral there: the panel would report the package gone while the plugin sat
    in the load path, still scanned, still in the drawer, with no way to remove
    it from inside the app. */
bool mayDeleteManagedPlugin (const juce::String& recordedFingerprint,
                             const juce::String& fingerprintNow,
                             bool directoryIsExclusive);
