#include "Catalogue.h"

#include <algorithm>

namespace
{
/** Hex, lowercase, exactly 64 chars — a SHA-256 and nothing else. A short or
    mixed-case value is a mistake worth failing on rather than normalising,
    because it usually means the field was hand-edited. */
bool isSha256Hex (const juce::String& s)
{
    if (s.length() != 64)
        return false;

    for (auto c : s)
        if (! ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
            return false;

    return true;
}

bool isHttpsUrl (const juce::String& s)
{
    return s.startsWith ("https://");
}

/** Catalogue ids become staging-directory and marker-file names. Keep them to
    the same deliberately small alphabet used by the authoring tools: besides
    being portable, this excludes the `.` and `..` path segments before JUCE
    has a chance to normalise them. */
bool isSafeCatalogueId (const juce::String& id)
{
    if (id.isEmpty())
        return false;

    for (const auto c : id)
        if (! ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
               || (c >= '0' && c <= '9') || c == '-' || c == '_'))
            return false;

    return true;
}

/** A package's or link's category path, outermost heading first.

    Accepts either a single string ("Effects") or an array of them
    (["Effects", "Reverb"]), because the authoring format does: one heading
    needs no brackets, and every catalogue written before subsections existed
    uses the string form.

    Deliberately lenient — blank segments are dropped rather than rejected —
    which is the exact opposite of how `kind` is read a few lines below, and for
    the reason that keeps the two apart: this decides only which heading a row
    appears under, so a malformed one costs a misplaced row, while rejecting the
    catalogue over it would cost every package in it. */
juce::StringArray parseCategoryPath (const juce::var& value)
{
    juce::StringArray path;

    if (const auto* segments = value.getArray())
    {
        for (const auto& segment : *segments)
            path.add (segment.toString());
    }
    else
    {
        path.add (value.toString());
    }

    path.trim();
    path.removeEmptyStrings();
    return path;
}

/// Recursive wildcard match over forward-slash paths.
///
/// `**` may cross separators, `*` may not — the distinction is what lets
/// "*.vst3" mean a bundle at the archive root while "**/*.vst3/**" reaches
/// the files inside one at any depth.
///
/// `**/` matches *zero* or more leading segments, per the usual glob
/// convention. Without the zero case, "**/*.vst3/**" would miss a bundle
/// sitting at the root of the archive — which is how several of these
/// projects package their releases.
bool wildcardMatch (const juce::String& path, int pathPos,
                    const juce::String& pattern, int patternPos)
{
    const auto pathLen = path.length();
    const auto patternLen = pattern.length();

    while (patternPos < patternLen)
    {
        const auto pc = pattern[patternPos];

        if (pc == '*')
        {
            const bool isDoubleStar = (patternPos + 1 < patternLen && pattern[patternPos + 1] == '*');

            if (isDoubleStar)
            {
                const bool followedBySlash = (patternPos + 2 < patternLen && pattern[patternPos + 2] == '/');

                if (followedBySlash)
                {
                    // Try the rest of the pattern at the start of every
                    // segment, beginning with "no segments consumed at all".
                    const auto afterSlash = patternPos + 3;

                    if (wildcardMatch (path, pathPos, pattern, afterSlash))
                        return true;

                    for (int i = pathPos; i < pathLen; ++i)
                        if (path[i] == '/' && wildcardMatch (path, i + 1, pattern, afterSlash))
                            return true;

                    return false;
                }

                // A trailing (or bare) ** swallows anything, separators included.
                for (int i = pathPos; i <= pathLen; ++i)
                    if (wildcardMatch (path, i, pattern, patternPos + 2))
                        return true;

                return false;
            }

            for (int i = pathPos; i <= pathLen; ++i)
            {
                if (i > pathPos && path[i - 1] == '/')
                    break; // a single star stops at a separator

                if (wildcardMatch (path, i, pattern, patternPos + 1))
                    return true;
            }

            return false;
        }

        if (pathPos >= pathLen || path[pathPos] != pc)
            return false;

        ++pathPos;
        ++patternPos;
    }

    return pathPos == pathLen;
}
} // namespace

juce::String toString (CatalogueSource source)
{
    switch (source)
    {
        case CatalogueSource::none:     return "none";
        case CatalogueSource::devLocal: return "devLocal";
        case CatalogueSource::remote:   return "remote";
        case CatalogueSource::cache:    return "cache";
    }

    return "none";
}

bool CatalogueAsset::isValid (const juce::String& what, juce::String& reasonOut) const
{
    if (! isHttpsUrl (url))    { reasonOut = what + " url is not https"; return false; }
    if (! isSha256Hex (sha256)) { reasonOut = what + " sha256 is not 64 lowercase hex chars"; return false; }
    return true;
}

std::optional<CatalogueAsset> CataloguePackage::assetFor (const juce::String& platformSlug) const
{
    const auto found = assets.find (platformSlug);
    if (found == assets.end())
        return std::nullopt;

    auto asset = found->second;
    if (asset.include.isEmpty())
        asset.include = include;
    return asset;
}

bool CataloguePackage::isValid (juce::String& reasonOut) const
{
    const auto what = juce::String (isContent() ? "content '" : "plugin '") + id + "'";

    if (! isSafeCatalogueId (id))
    {
        reasonOut = "package id is not a plain path-safe name";
        return false;
    }
    if (name.isEmpty())              { reasonOut = what + " has no name"; return false; }
    if (version.isEmpty())           { reasonOut = what + " has no version"; return false; }
    if (licenseId.isEmpty())         { reasonOut = what + " has no licenseId"; return false; }
    if (! isHttpsUrl (projectUrl))   { reasonOut = what + " projectUrl is not https"; return false; }
    if (include.isEmpty())           { reasonOut = what + " has no include patterns"; return false; }

    // A package offered on no platform is not a package. Each asset was
    // checked as it was read; this is the one thing only the whole map can
    // answer, and an entry that reaches here with none is a malformed
    // catalogue rather than a package this build happens not to support.
    if (assets.empty())              { reasonOut = what + " names no platform assets"; return false; }

    // Self-reference is the one dependency error visible from a single entry;
    // whether the id names anything needs the whole catalogue, and is checked
    // once parsing is done.
    if (dependsOn == id)             { reasonOut = what + " depends on itself"; return false; }

    if (isContent())
    {
        // installDir is joined to a path, so it must be a plain folder name.
        // The same rule, and the same reason, as an install marker's file name.
        if (! isSafeInstalledFileName (installDir))
        {
            reasonOut = what + " installDir is not a plain folder name";
            return false;
        }
    }
    else if (installDir.isNotEmpty())
    {
        // A plugin naming its own destination is either a mislabelled content
        // package or an attempt to land executable code outside the managed
        // VST3 directory. Neither may pass.
        reasonOut = what + " is a plugin but names an installDir";
        return false;
    }
    else if (preserveStructure)
    {
        // A VST3 bundle's layout is the installer's business, decided by
        // isOutermostPluginPath rather than by the archive. A plugin asking to
        // keep its own nesting is asking for something this does not offer.
        reasonOut = what + " is a plugin but asks to preserve its structure";
        return false;
    }

    return true;
}

bool CatalogueBundle::isValid (juce::String& reasonOut) const
{
    if (! isSafeCatalogueId (id))
    {
        reasonOut = "bundle id is not a plain path-safe name";
        return false;
    }
    if (name.isEmpty())        { reasonOut = "bundle '" + id + "' has no name"; return false; }
    if (version.isEmpty())     { reasonOut = "bundle '" + id + "' has no version"; return false; }
    if (packageIds.isEmpty())  { reasonOut = "bundle '" + id + "' names no packages"; return false; }

    return true;
}

Catalogue parseCatalogueManifest (const juce::String& json, juce::String& errorOut)
{
    errorOut.clear();

    juce::var root;
    const auto result = juce::JSON::parse (json, root);

    if (result.failed() || ! root.isObject())
    {
        errorOut = "manifest is not valid JSON";
        return {};
    }

    const auto schema = root["schemaVersion"];
    if (! schema.isInt())
    {
        errorOut = "manifest has no schemaVersion";
        return {};
    }

    // Refuse a newer schema outright rather than parse what we recognise: a
    // field this build ignores could be the one that changes what a plugin or
    // bundle means. The caller falls back to a catalogue it does understand.
    if (static_cast<int> (schema) > catalogueSchemaVersion)
    {
        errorOut = "manifest schemaVersion " + schema.toString()
                 + " is newer than this build understands (" + juce::String (catalogueSchemaVersion)
                 + ") — update Plectrify";
        return {};
    }

    // And refuse an older one by name rather than by symptom. Every package's
    // payload moved into `assets` at 4, so a 3 would fail a field at a time
    // and report "assets is not an object" — true, but not the reason. This
    // only arises for a cache written by a previous build; the fetch that
    // follows replaces it.
    if (static_cast<int> (schema) < catalogueSchemaVersion)
    {
        errorOut = "manifest schemaVersion " + schema.toString()
                 + " predates the per-platform assets format ("
                 + juce::String (catalogueSchemaVersion) + ")";
        return {};
    }

    const auto revision = root["revision"];
    if ((! revision.isInt() && ! revision.isInt64())
        || static_cast<juce::int64> (revision) < 1)
    {
        errorOut = "manifest revision is not a positive integer";
        return {};
    }

    const auto* packages = root["packages"].getArray();
    if (packages == nullptr)
    {
        errorOut = "manifest has no packages array";
        return {};
    }

    Catalogue catalogue;
    catalogue.revision = static_cast<juce::int64> (revision);
    catalogue.packages.reserve (static_cast<size_t> (packages->size()));
    juce::StringArray markerKeys;

    for (const auto& entry : *packages)
    {
        if (! entry.isObject())
        {
            errorOut = "packages contains a non-object entry";
            return {};
        }

        CataloguePackage p;
        p.id = entry["id"].toString();

        // Read before anything else, and never defaulted: this is the field
        // that decides whether the payload is unzipped into the VST3 load path
        // and executed. An absent or misspelt kind rejects the catalogue rather
        // than quietly picking one.
        const auto kind = entry["kind"].toString();
        if (kind == "plugin")
            p.kind = PackageKind::plugin;
        else if (kind == "content")
            p.kind = PackageKind::content;
        else
        {
            errorOut = "package '" + p.id + "' has unknown kind '" + kind + "'";
            return {};
        }

        p.category      = parseCategoryPath (entry["category"]);
        p.name          = entry["name"].toString();
        p.purpose       = entry["purpose"].toString();
        p.version       = entry["version"].toString();
        p.licenseId     = entry["licenseId"].toString();
        p.licenseUrl    = entry["licenseUrl"].toString();
        p.projectUrl    = entry["projectUrl"].toString();
        p.sourceUrl     = entry["sourceUrl"].toString();
        p.minAppVersion = entry["minAppVersion"].toString();
        p.installDir    = entry["installDir"].toString();
        p.preserveStructure = static_cast<bool> (entry["preserveStructure"]);

        if (const auto* patterns = entry["include"].getArray())
            for (const auto& pattern : *patterns)
                p.include.add (pattern.toString());

        // Every platform's payload, this build's own included. Missing or
        // malformed rejects the catalogue like any other field, because each
        // entry carries a hash that authorises code onto some platform's disk.
        {
            const auto assetsVar = entry["assets"];
            const auto* assetsObject = assetsVar.getDynamicObject();
            if (assetsObject == nullptr)
            {
                errorOut = "package '" + p.id + "' assets is not an object";
                return {};
            }

            for (const auto& property : assetsObject->getProperties())
            {
                const auto slug = property.name.toString();
                const auto& value = property.value;

                if (! isSafeCatalogueId (slug))
                {
                    errorOut = "package '" + p.id + "' has an unsafe asset platform key";
                    return {};
                }
                if (! value.isObject())
                {
                    errorOut = "package '" + p.id + "' asset '" + slug + "' is not an object";
                    return {};
                }

                CatalogueAsset asset;
                asset.url           = value["url"].toString();
                asset.sha256        = value["sha256"].toString().toLowerCase();
                asset.downloadBytes = static_cast<juce::int64> (value["downloadBytes"]);
                asset.selfHosted    = static_cast<bool> (value["selfHosted"]);

                if (const auto* patterns = value["include"].getArray())
                    for (const auto& pattern : *patterns)
                        asset.include.add (pattern.toString());

                juce::String assetReason;
                if (! asset.isValid ("package '" + p.id + "' asset '" + slug + "'", assetReason))
                {
                    errorOut = assetReason;
                    return {};
                }

                p.assets[slug] = std::move (asset);
            }
        }

        // One id, never a list. Anything structural is rejected rather than
        // stringified, which would drop the dependency and install the package
        // on its own — the one outcome this field exists to prevent.
        const auto dependency = entry["dependsOn"];

        if (dependency.isArray() || dependency.isObject())
        {
            errorOut = "package '" + p.id + "' dependsOn must be a single package id";
            return {};
        }

        p.dependsOn = dependency.toString();

        juce::String reason;
        if (! p.isValid (reason))
        {
            // All-or-nothing: a catalogue missing one package still looks
            // complete in the panel, which is worse than showing none.
            errorOut = reason;
            return {};
        }

        for (const auto& existing : catalogue.packages)
        {
            if (existing.id == p.id)
            {
                errorOut = "duplicate package id '" + p.id + "'";
                return {};
            }
        }

        const auto markerKey = p.isContent() ? "content-" + p.id : p.id;
        if (markerKeys.contains (markerKey, true))
        {
            errorOut = "install marker key collision at package '" + p.id + "'";
            return {};
        }
        markerKeys.add (markerKey);

        catalogue.packages.push_back (std::move (p));
    }

    // Resolved after every package is read, so order in the file does not
    // matter. A dependency may only name a package this same catalogue defines:
    // it decides what is installed alongside the thing the user actually asked
    // for, so an id naming nothing would quietly install less than the row
    // promised, and one naming something outside the catalogue would be a
    // payload with no entry, no hash and nobody's review behind it.
    for (const auto& p : catalogue.packages)
    {
        if (p.dependsOn.isEmpty())
            continue;

        const auto found = std::any_of (
            catalogue.packages.begin(), catalogue.packages.end(),
            [&p] (const CataloguePackage& c) { return c.id == p.dependsOn; });

        if (! found)
        {
            errorOut = "package '" + p.id + "' depends on unknown package '" + p.dependsOn + "'";
            return {};
        }
    }

    // Bundles are optional: a catalogue of loose packages with no bundle is a
    // legitimate state, and one the panel renders fine.
    if (const auto* bundles = root["bundles"].getArray())
    {
        catalogue.bundles.reserve (static_cast<size_t> (bundles->size()));

        for (const auto& entry : *bundles)
        {
            if (! entry.isObject())
            {
                errorOut = "bundles contains a non-object entry";
                return {};
            }

            CatalogueBundle bundle;
            bundle.id          = entry["id"].toString();
            bundle.name        = entry["name"].toString();
            bundle.description = entry["description"].toString();
            bundle.version     = entry["version"].toString();

            if (const auto* ids = entry["packageIds"].getArray())
                for (const auto& id : *ids)
                    bundle.packageIds.add (id.toString());

            juce::String reason;
            if (! bundle.isValid (reason))
            {
                errorOut = reason;
                return {};
            }

            for (const auto& existing : catalogue.bundles)
            {
                if (existing.id == bundle.id)
                {
                    errorOut = "duplicate bundle id '" + bundle.id + "'";
                    return {};
                }
            }

            const auto markerKey = "bundle-" + bundle.id;
            if (markerKeys.contains (markerKey, true))
            {
                errorOut = "install marker key collision at bundle '" + bundle.id + "'";
                return {};
            }
            markerKeys.add (markerKey);

            // A bundle naming a package that is not defined would render as a
            // bundle the user can never fully install, with no indication why.
            // Better to reject the catalogue and fall back to one that is
            // coherent.
            for (const auto& packageId : bundle.packageIds)
            {
                const auto found = std::any_of (
                    catalogue.packages.begin(), catalogue.packages.end(),
                    [&packageId] (const CataloguePackage& p) { return p.id == packageId; });

                if (! found)
                {
                    errorOut = "bundle '" + bundle.id + "' names unknown package '" + packageId + "'";
                    return {};
                }
            }

            catalogue.bundles.push_back (std::move (bundle));
        }
    }

    return catalogue;
}

bool isCatalogueRevisionRollback (juce::int64 candidateRevision,
                                  juce::int64 acceptedRevision) noexcept
{
    return candidateRevision < acceptedRevision;
}

juce::StringArray resolveInstallOrder (const Catalogue& catalogue,
                                       const juce::StringArray& requested)
{
    juce::StringArray out;

    for (const auto& id : requested)
    {
        // Follow the chain to its end, then add it back to front so every
        // dependency lands before whatever named it. `chain` doubles as the
        // loop guard: a package it already holds ends the walk.
        juce::StringArray chain;

        for (auto next = id; next.isNotEmpty() && ! chain.contains (next);)
        {
            const auto package = std::find_if (
                catalogue.packages.begin(), catalogue.packages.end(),
                [&next] (const CataloguePackage& p) { return p.id == next; });

            // An id the catalogue does not define is dropped: there is nothing
            // to download, and the installer would pass over it anyway.
            if (package == catalogue.packages.end())
                break;

            chain.add (next);
            next = package->dependsOn;
        }

        for (int i = chain.size(); --i >= 0;)
            out.addIfNotAlreadyThere (chain[i]);
    }

    return out;
}

CatalogueNotices parseCatalogueNotices (const juce::String& json)
{
    juce::var root;
    if (juce::JSON::parse (json, root).failed() || ! root.isObject())
        return {};

    const auto notices = root["notices"];
    if (! notices.isObject())
        return {};

    CatalogueNotices out;
    out.summary   = notices["summary"].toString();
    out.fetched   = notices["fetched"].toString();
    out.hosted    = notices["hosted"].toString();
    out.models    = notices["models"].toString();
    out.uninstall = notices["uninstall"].toString();
    return out;
}

std::vector<CatalogueLink> parseCatalogueLinks (const juce::String& json)
{
    juce::var root;
    if (juce::JSON::parse (json, root).failed() || ! root.isObject())
        return {};

    const auto* links = root["links"].getArray();
    if (links == nullptr)
        return {};

    std::vector<CatalogueLink> out;

    for (const auto& entry : *links)
    {
        CatalogueLink link;
        link.category = parseCategoryPath (entry["category"]);
        link.label    = entry["label"].toString();
        link.url      = entry["url"].toString();
        link.note     = entry["note"].toString();

        // https only, matching handleOpenExternalUrl's own guard: these are
        // handed to the user's browser, and a catalogue is fetched over the
        // network.
        if (link.label.isNotEmpty() && link.url.startsWith ("https://"))
            out.push_back (std::move (link));
    }

    return out;
}

juce::String sha256Hex (const void* data, size_t numBytes)
{
    return juce::SHA256 (data, numBytes).toHexString().toLowerCase();
}

bool verifyManifestSignature (const void* manifestBytes,
                              size_t numBytes,
                              const juce::String& signatureHex,
                              const juce::RSAKey& publicKey)
{
    if (manifestBytes == nullptr || numBytes == 0 || signatureHex.isEmpty())
        return false;

    // An uninitialised key would otherwise "verify" whatever it was handed.
    if (publicKey.toString().isEmpty())
        return false;

    juce::BigInteger signature;
    signature.parseString (signatureHex, 16);
    if (signature.isZero())
        return false;

    juce::BigInteger expected;
    expected.parseString (sha256Hex (manifestBytes, numBytes), 16);

    publicKey.applyToValue (signature);

    // Compare integers, not strings: hex rendering drops leading zeros, so
    // string equality would depend on the digest's high byte.
    return signature == expected;
}

juce::RSAKey catalogueSigningKey()
{
    // Public half of the offline manifest signing key. Empty until a keypair
    // is generated and pasted here (see RELEASING.md). While empty,
    // verifyManifestSignature() refuses every signature, so a build without a
    // key shows no catalogue rather than trusting whatever the network
    // returned.
    //
    // Rotation: this is a plain constant, so a second key can ship in a
    // release before the first is retired.
    constexpr const char* publicKey =
        "10001,ad17fd8999187ca8d887069c364b35f21fae25fe4924b89f6ad8c0372d54a453"
        "631930d08e82b31af35e4a3ce1aad22dbc6325c2f3da6dce427156c478cdefc892f3e2"
        "9dc4994f0c85bc08c64b5ef4486d892c62d17c240a2ea78af73577e4c43de5c8f789ae"
        "f353581f8b9614551dadad3a9c882488010610eddec3b1f525654c0d7daed33218aeea"
        "50226eaf202120fa511998e0348b291f630c742dec5fd346fb2624893a8c5696aea06f"
        "89d14a6160d3dc0bc311c37b6706714c71f626a001dc18dea1d4ba19825e4745a717f8"
        "ec28777eaf78b1e481020d216f1e4b4dee56b1f557e9523036320845b734aef4400e20"
        "be93f4abaf0c03dbd7d5a43c5579";

    return juce::RSAKey (juce::String (publicKey));
}

bool matchesIncludePattern (const juce::String& path, const juce::String& pattern)
{
    if (pattern.isEmpty() || path.isEmpty())
        return false;

    // Zip entry names may legally use either separator, and they do in
    // practice: archives built with PowerShell's Compress-Archive write
    // backslashes, while the upstream release zips use forward slashes. The
    // patterns are written with forward slashes, so normalise rather than
    // silently matching nothing and reporting "no VST3 in the download".
    //
    // Plectrify's own re-hosting tools have since moved onto one reproducible
    // zipper that always writes forward slashes, but the archives they produced
    // before that are still live and still pinned, so this stays.
    return wildcardMatch (path.replaceCharacter ('\\', '/'), 0, pattern, 0);
}

bool matchesAnyIncludePattern (const juce::String& path, const juce::StringArray& patterns)
{
    for (const auto& pattern : patterns)
        if (matchesIncludePattern (path, pattern))
            return true;

    return false;
}

bool isOutermostPluginPath (const juce::String& relativePath)
{
    juce::StringArray segments;
    segments.addTokens (relativePath.replaceCharacter ('\\', '/'), "/", "");
    segments.removeEmptyStrings();

    if (segments.isEmpty())
        return false;

    if (! segments[segments.size() - 1].endsWithIgnoreCase (".vst3"))
        return false;

    // Any ancestor ending in .vst3 means this is a file inside a bundle.
    for (int i = 0; i < segments.size() - 1; ++i)
        if (segments[i].endsWithIgnoreCase (".vst3"))
            return false;

    return true;
}

bool isSafeInstalledFileName (const juce::String& fileName)
{
    if (fileName.isEmpty() || fileName == "." || fileName == "..")
        return false;

    if (fileName.containsAnyOf ("/\\:"))
        return false;

    return true;
}

bool isApprovedInstallMarkerDirectory (const juce::String& recordedPath,
                                       const juce::File& managedPluginDirectory,
                                       const juce::File& contentParentDirectory,
                                       bool contentMarker)
{
    if (! juce::File::isAbsolutePath (recordedPath))
        return false;

    const juce::File recorded { recordedPath };

    if (recorded == managedPluginDirectory)
        return true;

    if (! contentMarker)
        return false;

    const auto name = recorded.getFileName();
    return recorded.getParentDirectory() == contentParentDirectory
        && isSafeInstalledFileName (name)
        && ! name.equalsIgnoreCase (".plectrify-installed")
        && ! name.equalsIgnoreCase (".staging")
        && name != managedPluginDirectory.getFileName();
}

static bool hasHiddenPathSegment (const juce::String& relativePath)
{
    juce::StringArray segments;
    segments.addTokens (relativePath, "/", "");

    for (const auto& segment : segments)
        if (segment.startsWithChar ('.'))
            return true;

    return false;
}

juce::String installedFileFingerprint (const juce::File& installedPath)
{
    const auto describe = [] (const juce::File& entry, const juce::String& name)
    {
        return entry.isDirectory() ? "d:" + name
                                   : "f:" + juce::String (entry.getSize()) + ":" + name;
    };

    juce::StringArray entries;

    if (installedPath.isDirectory())
    {
        for (const auto& child : installedPath.findChildFiles (juce::File::findFilesAndDirectories,
                                                               true, "*",
                                                               juce::File::FollowSymlinks::no))
        {
            const auto relative = child.getRelativePathFrom (installedPath).replaceCharacter ('\\', '/');

            if (hasHiddenPathSegment (relative))
                continue;

            entries.add (describe (child, relative));
        }

        // findChildFiles documents its order as undefined, and the same bundle
        // has to fingerprint identically on the machine that installed it.
        entries.sort (false);
    }
    else if (installedPath.existsAsFile())
    {
        entries.add (describe (installedPath, installedPath.getFileName()));
    }
    else
    {
        return {};
    }

    const auto joined = entries.joinIntoString ("\n");
    return juce::SHA256 (joined.toRawUTF8(), joined.getNumBytesAsUTF8()).toHexString().toLowerCase();
}

bool mayReplaceManagedPlugin (bool nameIsClaimed,
                              const juce::String& claimedFingerprint,
                              const juce::String& fingerprintNow,
                              bool directoryIsExclusive)
{
    if (! nameIsClaimed)
        return directoryIsExclusive;

    // Claimed, but with nothing recorded to compare against: a marker written
    // before fingerprints existed, or the claim an in-flight install writes
    // before it moves anything. Either way Plectrify wrote — or is writing —
    // that name, so it is ours to replace.
    if (claimedFingerprint.isEmpty())
        return true;

    return claimedFingerprint == fingerprintNow;
}

bool mayDeleteManagedPlugin (const juce::String& recordedFingerprint,
                             const juce::String& fingerprintNow,
                             bool directoryIsExclusive)
{
    if (recordedFingerprint.isEmpty())
        return true;

    return recordedFingerprint == fingerprintNow || directoryIsExclusive;
}

bool isSafeArchiveEntryName (const juce::String& entryName)
{
    if (entryName.isEmpty())
        return false;

    // Normalise separators first: a backslash is a legal character in a zip
    // entry name, and treating "..\\x" as one opaque segment would let it past
    // the `..` check below.
    const auto normalised = entryName.replaceCharacter ('\\', '/');

    if (normalised.startsWithChar ('/'))
        return false; // absolute

    if (normalised.contains (":"))
        return false; // drive letter or alternate data stream

    juce::StringArray segments;
    segments.addTokens (normalised, "/", "");

    for (const auto& segment : segments)
        if (segment == "..")
            return false;

    return true;
}

bool isSafeSymlinkTarget (const juce::String& target)
{
    // Same rules as an entry name — relative, no drive letter, no `..` — so a
    // recreated link can only point at something extracted beside it. The
    // signed manifest already vouches for the archive; this is defence in
    // depth against a link reaching outside the install directory.
    return isSafeArchiveEntryName (target);
}

bool archiveEntryIsExecutable (juce::uint32 externalFileAttributes)
{
    const auto mode = externalFileAttributes >> 16;
    const auto fileType = (externalFileAttributes >> 28) & 0xf;

    constexpr juce::uint32 regularFile = 0x8;
    if (fileType != 0 && fileType != regularFile)
        return false;

    return (mode & 0111) != 0;
}
