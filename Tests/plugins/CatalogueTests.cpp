#include <JuceHeader.h>

#include "Catalogue.h"

#include <iostream>

// Offline coverage for the plugin catalogue's security-critical logic:
// signature verification (the gate that decides whether network bytes may be
// parsed at all), archive-entry safety, the include-pattern matcher that picks
// what gets unpacked, and manifest validation.

namespace
{
int failures = 0;

void check (bool condition, const juce::String& what)
{
    if (! condition)
    {
        ++failures;
        std::cerr << "FAIL " << what << "\n";
    }
}

juce::String validManifest (const juce::String& overrides = {})
{
    return R"({
        "schemaVersion": 4,
        "revision": 3,
        "packages": [
            {
                "id": "zam-plugins",
                "kind": "plugin",
                "category": "Effects",
                "name": "ZamPlugins",
                "purpose": "Gate, compressor, EQ",
                "version": "4.5",
                "licenseId": "GPL-2.0-or-later",
                "projectUrl": "https://github.com/zamaudio/zam-plugins",
                "include": ["**/*.vst3/**", "*.vst3"],
                "assets": {
                    "windows-x64": {
                        "url": "https://github.com/zamaudio/zam-plugins/releases/download/4.5/z.zip",
                        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                        "downloadBytes": 1234
                    }
                }
            }
        ]
    })" + overrides;
}

void testManifestParsing()
{
    juce::String error;

    auto catalogue = parseCatalogueManifest (validManifest(), error);
    check (error.isEmpty() && catalogue.packages.size() == 1, "a valid manifest parses");
    check (catalogue.revision == 3, "the monotonic manifest revision is read");
    check (catalogue.packages.size() == 1 && catalogue.packages[0].version == "4.5", "version is read");
    check (catalogue.packages.size() == 1
               && catalogue.packages[0].assetFor ("windows-x64")
               && catalogue.packages[0].assetFor ("windows-x64")->downloadBytes == 1234,
           "an asset's downloadBytes is read");

    parseCatalogueManifest ("{ not json", error);
    check (error.isNotEmpty(), "malformed JSON is reported, not crashed on");

    // A newer schema must be refused wholesale: a field this build silently
    // ignores could be the one that changes what a package means.
    catalogue = parseCatalogueManifest (
        juce::String (R"({"schemaVersion": 99, "packages": []})"), error);
    check (catalogue.packages.empty() && error.contains ("newer"), "a newer schemaVersion is rejected");

    catalogue = parseCatalogueManifest (
        validManifest().replace (R"("revision": 3)", R"("revision": 0)"), error);
    check (catalogue.packages.empty() && error.contains ("revision"),
           "a non-positive revision is rejected instead of defeating rollback protection");

    catalogue = parseCatalogueManifest (
        validManifest().replace (R"("revision": 3)", R"("notRevision": 3)"), error);
    check (catalogue.packages.empty() && error.contains ("revision"),
           "a missing revision is rejected instead of defaulting to zero");

    check (isCatalogueRevisionRollback (2, 3),
           "an older signed revision is recognised as a rollback");
    check (! isCatalogueRevisionRollback (3, 3),
           "refreshing the accepted revision is allowed");
    check (! isCatalogueRevisionRollback (4, 3),
           "a newer signed revision advances the catalogue");

    for (const auto* unsafeId : { ".", "..", "nested/package" })
    {
        const auto manifest = validManifest().replace (
            R"("id": "zam-plugins")",
            R"("id": ")" + juce::String (unsafeId) + R"(")");
        catalogue = parseCatalogueManifest (manifest, error);
        check (catalogue.packages.empty() && error.contains ("path-safe"),
               "unsafe package id '" + juce::String (unsafeId) + "' is rejected");
    }

    // A manifest predating the per-platform assets format is refused by name.
    // Its packages carry no `assets`, so parsing it field by field would report
    // a missing object rather than an outdated document.
    catalogue = parseCatalogueManifest (
        validManifest().replace (R"("schemaVersion": 4)", R"("schemaVersion": 3)"), error);
    check (catalogue.packages.empty() && error.contains ("predates"),
           "a manifest older than the assets format is rejected as outdated");

    // All-or-nothing: a catalogue missing one package still looks complete.
    catalogue = parseCatalogueManifest (
        juce::String (R"({"schemaVersion":4,"revision":1,"packages":[
            {"id":"a","kind":"plugin","name":"A","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/a.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}},
            {"id":"b","kind":"plugin","name":"B","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/b.zip","downloadBytes":1,
             "sha256":"nope"}}}]})"), error);
    check (catalogue.packages.empty() && error.isNotEmpty(), "one bad plugin rejects the whole catalogue");

    catalogue = parseCatalogueManifest (
        juce::String (R"({"schemaVersion":4,"revision":1,"packages":[
            {"id":"a","kind":"plugin","name":"A","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"http://insecure/a.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}}]})"), error);
    check (catalogue.packages.empty(), "a plain-http asset url is rejected");

    catalogue = parseCatalogueManifest (
        juce::String (R"({"schemaVersion":4,"revision":1,"packages":[
            {"id":"dup","kind":"plugin","name":"A","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/a.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}},
            {"id":"dup","kind":"plugin","name":"B","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/b.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}}]})"), error);
    check (catalogue.packages.empty() && error.contains ("duplicate"), "duplicate ids are rejected");
}

// Per-platform assets. Every payload is an entry in `assets`, this build's own
// included: there is no privileged platform to read differently and no fallback
// from one to another. Each entry pins a hash that authorises code onto some
// platform's disk, so all of them are validated identically.
void testPlatformAssets()
{
    juce::String error;

    // One platform declared: offered there, and nowhere else. The absence is
    // the point — it must not fall back to somebody else's binary.
    auto catalogue = parseCatalogueManifest (validManifest(), error);
    check (error.isEmpty() && catalogue.packages.size() == 1, "a single-platform manifest parses");
    if (catalogue.packages.size() == 1)
    {
        const auto& p = catalogue.packages[0];

        const auto win = p.assetFor ("windows-x64");
        check (win.has_value(), "the declared platform is offered");
        check (win && win->url.endsWith ("z.zip") && win->downloadBytes == 1234,
               "the asset reads its own url and size");

        check (! p.assetFor ("macos-arm64").has_value(),
               "a platform with no asset is not offered the package");
    }

    // Both platforms, the mac one with its own include patterns.
    const auto bothPlatforms = validManifest().replace (
        R"("windows-x64": {)",
        R"("macos-arm64": {
                        "url": "https://github.com/zamaudio/zam-plugins/releases/download/4.5/z-mac.zip",
                        "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
                        "downloadBytes": 5678,
                        "include": ["*.vst3"]
                    },
                    "windows-x64": {)");

    catalogue = parseCatalogueManifest (bothPlatforms, error);
    check (error.isEmpty() && catalogue.packages.size() == 1, "a two-platform manifest parses");
    if (catalogue.packages.size() == 1)
    {
        const auto& p = catalogue.packages[0];

        const auto mac = p.assetFor ("macos-arm64");
        const auto win = p.assetFor ("windows-x64");
        check (mac && mac->url.endsWith ("z-mac.zip") && mac->downloadBytes == 5678,
               "the mac asset reads its own url and size");
        check (win && win->url.endsWith ("z.zip") && win->downloadBytes == 1234,
               "the windows asset reads its own url and size");
        check (mac && win && mac->sha256 != win->sha256,
               "the two platforms pin their own hashes, not a shared one");
        check (mac && mac->include.size() == 1 && mac->include[0] == "*.vst3",
               "an asset's own include wins");
        check (win && win->include == p.include,
               "an asset with no include inherits the package's");
    }

    // Who serves the bytes is per asset, because a package may be a re-host on
    // one platform and a mirror of the project's own download on the other.
    const auto halfHosted = bothPlatforms.replace (
        R"("downloadBytes": 5678,)",
        R"("downloadBytes": 5678, "selfHosted": true,)");

    catalogue = parseCatalogueManifest (halfHosted, error);
    check (error.isEmpty() && catalogue.packages.size() == 1, "a half-hosted manifest parses");
    if (catalogue.packages.size() == 1)
    {
        const auto& p = catalogue.packages[0];
        const auto mac = p.assetFor ("macos-arm64");
        const auto win = p.assetFor ("windows-x64");

        check (mac && mac->selfHosted, "the hosted platform's asset says so");
        check (win && ! win->selfHosted,
               "the other platform is unaffected — the flag is the asset's, not the package's");
    }

    // A slug this build knows nothing about is kept rather than refused: it is
    // some other build's platform, and rejecting it would make adding one a
    // schema change. It simply never matches this build's own.
    catalogue = parseCatalogueManifest (
        bothPlatforms.replace (R"("macos-arm64": {)", R"("linux-x64": {)"), error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && ! catalogue.packages[0].assetFor ("macos-arm64").has_value()
               && catalogue.packages[0].assetFor ("windows-x64").has_value(),
           "an unknown platform slug is carried but never selected");

    // Malformed entries reject the whole catalogue, whichever platform they are.
    for (const auto& [find, replace, expected, what] :
         { std::tuple { R"("url": "https://github.com/zamaudio/zam-plugins/releases/download/4.5/z-mac.zip")",
                        R"("url": "http://github.com/z-mac.zip")",
                        "https", "a plain-http url on the mac asset" },
           std::tuple { R"("url": "https://github.com/zamaudio/zam-plugins/releases/download/4.5/z.zip")",
                        R"("url": "http://github.com/z.zip")",
                        "https", "a plain-http url on the windows asset" },
           std::tuple { R"("sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")",
                        R"("sha256": "nope")", "sha256", "a malformed hash on the mac asset" },
           std::tuple { R"("sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")",
                        R"("sha256": "nope")", "sha256", "a malformed hash on the windows asset" } })
    {
        catalogue = parseCatalogueManifest (bothPlatforms.replace (find, replace), error);
        check (catalogue.packages.empty() && error.contains (expected),
               juce::String (what) + " rejects the catalogue");
    }

    // A package offered on no platform at all is not a package: it would render
    // as a row nobody can ever install, with nothing saying why.
    catalogue = parseCatalogueManifest (
        juce::String (R"({"schemaVersion":4,"revision":1,"packages":[
            {"id":"a","kind":"plugin","name":"A","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],"assets":{}}]})"), error);
    check (catalogue.packages.empty() && error.contains ("platform"),
           "a package with an empty assets map rejects the catalogue");

    catalogue = parseCatalogueManifest (
        validManifest().replace (R"("assets": {)", R"("assets": "z.zip", "unused": {)"), error);
    check (catalogue.packages.empty() && error.contains ("assets"),
           "a non-object assets block rejects the catalogue");
}

// `kind` decides whether a payload is unzipped into the VST3 load path and
// executed, so it gets the same scrutiny as the signature: never defaulted,
// never inferred, and never confusable with the cosmetic `category`.
void testPackageKind()
{
    juce::String error;

    const juce::String prefix = R"({"schemaVersion":4,"revision":1,"packages":[{"id":"a",)";
    const juce::String suffix =
        R"("name":"A","version":"1","licenseId":"MIT",
            "projectUrl":"https://x/y","include":["*.vst3"],
            "assets":{"windows-x64":{"url":"https://x/a.zip","downloadBytes":1,
            "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}}]})";

    auto catalogue = parseCatalogueManifest (prefix + R"("kind":"plugin",)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].kind == PackageKind::plugin,
           "kind 'plugin' parses");

    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"content","installDir":"irs",)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1 && catalogue.packages[0].isContent(),
           "kind 'content' parses");

    // An absent kind must not fall through to a default — least of all to
    // 'plugin', which is the one that ends up being executed.
    catalogue = parseCatalogueManifest (prefix + suffix, error);
    check (catalogue.packages.empty() && error.contains ("kind"),
           "a package with no kind rejects the catalogue");

    catalogue = parseCatalogueManifest (prefix + R"("kind":"Plugin",)" + suffix, error);
    check (catalogue.packages.empty(), "kind is matched exactly, not case-insensitively");

    catalogue = parseCatalogueManifest (prefix + R"("kind":"executable",)" + suffix, error);
    check (catalogue.packages.empty() && error.contains ("kind"), "an unknown kind is rejected");

    // A plugin naming its own destination is either a mislabelled content
    // package or an attempt to land executable code outside the managed
    // directory.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"plugin","installDir":"anywhere",)" + suffix, error);
    check (catalogue.packages.empty() && error.contains ("installDir"),
           "a plugin naming an installDir is rejected");

    // ...and content must not escape the Plectrify folder with the one it names.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"content","installDir":"../../elsewhere",)" + suffix, error);
    check (catalogue.packages.empty() && error.contains ("installDir"),
           "a content installDir that is a path is rejected");

    catalogue = parseCatalogueManifest (prefix + R"("kind":"content",)" + suffix, error);
    check (catalogue.packages.empty(), "content with no installDir is rejected");

    // Category is cosmetic and must stay that way: it is carried verbatim and
    // has no bearing on the kind beside it.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"content","installDir":"irs","category":"Cabs & IRs",)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].category == juce::StringArray { "Cabs & IRs" }
               && catalogue.packages[0].isContent(),
           "a single category is read verbatim as a one-segment path, and does not affect kind");

    // The array form is a heading path: the panel renders the last segment as a
    // subsection of the ones before it.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"plugin","category":["Effects","Reverb"],)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].category == juce::StringArray { "Effects", "Reverb" },
           "a category path parses outermost heading first");

    // Lenient where `kind` is strict, and deliberately: a blank heading costs
    // one misplaced row, while rejecting the catalogue over it costs every
    // package in it.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"plugin","category":["  Effects  ","","Reverb"],)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].category == juce::StringArray { "Effects", "Reverb" },
           "blank path segments are trimmed away rather than rejecting the catalogue");

    catalogue = parseCatalogueManifest (prefix + R"("kind":"plugin","category":"",)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].category.isEmpty(),
           "an absent category is not an error — the panel groups it as uncategorised");

    // Tags are the panel's filter chips, and cosmetic to exactly the same depth
    // as the category beside them: several per package, carried verbatim, and
    // no more able to say anything about the kind than a heading is.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"plugin","tags":["Delay","Modulation"],)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].tags == juce::StringArray { "Delay", "Modulation" }
               && ! catalogue.packages[0].isContent(),
           "tags parse in order, and do not affect kind");

    // A tag is a set membership rather than a position, so a repeat is dropped
    // — otherwise one row would count twice under its own chip.
    catalogue = parseCatalogueManifest (
        prefix + R"("kind":"plugin","tags":["Delay","  Delay  ","","Reverb"],)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].tags == juce::StringArray { "Delay", "Reverb" },
           "blank and repeated tags are dropped rather than rejecting the catalogue");

    catalogue = parseCatalogueManifest (prefix + R"("kind":"plugin",)" + suffix, error);
    check (error.isEmpty() && catalogue.packages.size() == 1
               && catalogue.packages[0].tags.isEmpty(),
           "an absent tags list is not an error — the package answers to no chip");
}

// A dependency points from the thing that needs something to the thing it needs
// — a patch names the plugin it was built for — and decides what gets installed
// alongside what the user actually asked for. So it may only name a package this
// same catalogue defines, and the order it produces is the point of the feature:
// a patch installed before its plugin is a patch that cannot be applied.
void testDependencies()
{
    juce::String error;

    const juce::String packages = R"({
        "schemaVersion": 4,
        "revision": 1,
        "packages": [
            {"id":"nam","kind":"plugin","name":"NAM","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/nam.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}},
            {"id":"jtm45","kind":"content","installDir":"patches","name":"JTM45","version":"1",
             "licenseId":"CC0-1.0","projectUrl":"https://x/y","include":["*/patch.json"],
             "assets":{"windows-x64":{"url":"https://x/jtm45.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}},
             "dependsOn":"nam"}
        ]})";

    auto catalogue = parseCatalogueManifest (packages, error);
    check (error.isEmpty() && catalogue.packages.size() == 2, "a dependency parses");
    check (catalogue.packages.size() == 2 && catalogue.packages[1].dependsOn == "nam",
           "the dependency is read off the package that needs it");

    // Content naming a plugin is the patch case exactly, and the only reason
    // the edge exists — it must not be mistaken for content overreaching.
    check (catalogue.packages.size() == 2 && catalogue.packages[1].isContent(),
           "content may depend on a plugin");

    check (resolveInstallOrder (catalogue, { "jtm45" }) == juce::StringArray ({ "nam", "jtm45" }),
           "installing a patch installs the plugin it names, first");
    check (resolveInstallOrder (catalogue, { "nam" }) == juce::StringArray ({ "nam" }),
           "installing the plugin brings no patches — the edge is one-way");
    check (resolveInstallOrder (catalogue, { "nam", "jtm45" }) == juce::StringArray ({ "nam", "jtm45" }),
           "asking for both downloads each once");
    check (resolveInstallOrder (catalogue, { "jtm45", "nam" }) == juce::StringArray ({ "nam", "jtm45" }),
           "the dependency comes first however the request was ordered");
    check (resolveInstallOrder (catalogue, { "ghost" }).isEmpty(),
           "an id the catalogue does not define is dropped");

    // An id naming nothing would install less than the row promised, with
    // nothing on screen saying so.
    const auto unknown = packages.replace (R"("dependsOn":"nam")", R"("dependsOn":"ghost")");
    catalogue = parseCatalogueManifest (unknown, error);
    check (catalogue.packages.empty() && error.contains ("ghost"),
           "depending on an unknown package rejects the catalogue");

    const auto self = packages.replace (R"("dependsOn":"nam")", R"("dependsOn":"jtm45")");
    catalogue = parseCatalogueManifest (self, error);
    check (catalogue.packages.empty() && error.contains ("itself"),
           "a package depending on itself rejects the catalogue");

    // One id, never a list: an array stringified into nothing would silently
    // install the patch alone, which is the one outcome this field prevents.
    const auto asArray = packages.replace (R"("dependsOn":"nam")", R"("dependsOn":["nam"])");
    catalogue = parseCatalogueManifest (asArray, error);
    check (catalogue.packages.empty() && error.contains ("single package id"),
           "a list of dependencies is rejected rather than stringified");

    // `validate` refuses to publish a loop; the resolver still has to terminate,
    // because the catalogue arrives over the network.
    const auto loop = packages.replace (R"("id":"nam","kind":"plugin")",
                                        R"("id":"nam","dependsOn":"jtm45","kind":"plugin")");
    catalogue = parseCatalogueManifest (loop, error);
    check (error.isEmpty() && resolveInstallOrder (catalogue, { "jtm45" }).size() == 2,
           "a dependency loop resolves to its members once instead of hanging");
}

void testBundleParsing()
{
    juce::String error;

    const juce::String twoPackages = R"({
        "schemaVersion": 4,
        "revision": 1,
        "packages": [
            {"id":"a","kind":"plugin","name":"A","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/a.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}},
            {"id":"b","kind":"plugin","name":"B","version":"1","licenseId":"MIT",
             "projectUrl":"https://x/y","include":["*.vst3"],
             "assets":{"windows-x64":{"url":"https://x/b.zip","downloadBytes":1,
             "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}}
        ],)";

    auto catalogue = parseCatalogueManifest (
        twoPackages + R"( "bundles":[{"id":"starter","name":"Starter","version":"3","packageIds":["a","b"]}]})",
        error);
    check (error.isEmpty() && catalogue.bundles.size() == 1, "a bundle parses");
    check (catalogue.bundles.size() == 1 && catalogue.bundles[0].version == "3", "a bundle's own version is read");
    check (catalogue.bundles.size() == 1 && catalogue.bundles[0].packageIds.size() == 2,
           "a bundle's plugin ids are read");

    // Bundles are optional — a catalogue of loose plugins is a legitimate state.
    catalogue = parseCatalogueManifest (twoPackages + R"( "links":[]})", error);
    check (error.isEmpty() && catalogue.packages.size() == 2 && catalogue.bundles.empty(),
           "a catalogue with no bundles is valid");

    const auto collidingPackages = twoPackages
        .replace (R"("id":"a","kind":"plugin")",
                  R"("id":"content-b","kind":"plugin")")
        .replace (R"("id":"b","kind":"plugin")",
                  R"("id":"b","kind":"content","installDir":"irs")");
    catalogue = parseCatalogueManifest (collidingPackages + R"( "links":[]})", error);
    check (catalogue.packages.empty() && error.contains ("marker key collision"),
           "plugin and content ids that map to one install marker are rejected");

    // A bundle pointing at a plugin that does not exist would render as a bundle
    // the user can never fully install, with nothing on screen explaining why.
    catalogue = parseCatalogueManifest (
        twoPackages + R"( "bundles":[{"id":"starter","name":"S","version":"1","packageIds":["a","ghost"]}]})",
        error);
    check (catalogue.packages.empty() && error.contains ("ghost"),
           "a bundle naming an unknown plugin rejects the catalogue");

    catalogue = parseCatalogueManifest (
        twoPackages + R"( "bundles":[{"id":"dup","kind":"plugin","name":"S","version":"1","packageIds":["a"]},
                                  {"id":"dup","kind":"plugin","name":"T","version":"1","packageIds":["b"]}]})",
        error);
    check (catalogue.packages.empty() && error.contains ("duplicate bundle"),
           "duplicate bundle ids are rejected");

    catalogue = parseCatalogueManifest (
        twoPackages + R"( "bundles":[{"id":"empty","name":"S","version":"1","packageIds":[]}]})",
        error);
    check (catalogue.packages.empty(), "a bundle naming no plugins is rejected");

    // A bundle and a plugin may share an id without colliding: they are separate
    // namespaces, which is why bundle markers are written with a prefix.
    catalogue = parseCatalogueManifest (
        twoPackages + R"( "bundles":[{"id":"a","kind":"plugin","name":"Confusing","version":"1","packageIds":["a"]}]})",
        error);
    check (error.isEmpty() && catalogue.bundles.size() == 1,
           "a bundle may share an id with a plugin");

    const auto bundleCollisionPackages = twoPackages.replace (
        R"("id":"b","kind":"plugin")", R"("id":"bundle-starter","kind":"plugin")");
    catalogue = parseCatalogueManifest (
        bundleCollisionPackages
            + R"( "bundles":[{"id":"starter","name":"S","version":"1","packageIds":["a"]}]})",
        error);
    check (catalogue.packages.empty() && error.contains ("marker key collision"),
           "plugin and bundle ids that map to one install marker are rejected");

    for (const auto* unsafeId : { ".", "..", "nested/bundle" })
    {
        catalogue = parseCatalogueManifest (
            twoPackages + R"( "bundles":[{"id":")" + juce::String (unsafeId)
                + R"(","name":"Unsafe","version":"1","packageIds":["a"]}]})",
            error);
        check (catalogue.packages.empty() && error.contains ("path-safe"),
               "unsafe bundle id '" + juce::String (unsafeId) + "' is rejected");
    }
}

// The catalogue that actually ships, run through the parser that actually
// reads it. `validate` already checks this file against the TypeScript rules,
// but the two implementations are edited separately and only agree by
// discipline — a field one accepts and the other rejects would otherwise
// surface as an empty Plugins panel at runtime.
void testRealCatalogueParses()
{
#if defined(PLECTRIFY_REAL_CATALOGUE)
    const juce::File file { PLECTRIFY_REAL_CATALOGUE };
    check (file.existsAsFile(), "the real catalogue.json is where CMake says it is");

    if (! file.existsAsFile())
        return;

    juce::String error;
    const auto text = file.loadFileAsString();
    const auto catalogue = parseCatalogueManifest (text, error);

    check (error.isEmpty(), "the shipped catalogue parses: " + error);
    check (! catalogue.packages.empty(), "the shipped catalogue offers at least one package");

    // Every package says what it is and where it belongs. Neither is enforced
    // by isValid — kind is checked while parsing and category is cosmetic — so
    // an entry added without them would parse and then render under the
    // fallback heading with nobody the wiser.
    for (const auto& package : catalogue.packages)
    {
        check (! package.category.isEmpty(),
               "shipped package '" + package.id + "' names a category");

        // Parsing drops blank segments, so an empty one here would mean the
        // whole path was blank — a heading that looks authored and renders as
        // the fallback.
        for (const auto& segment : package.category)
            check (segment.isNotEmpty(),
                   "shipped package '" + package.id + "' has no blank category segment");

        if (package.isContent())
            check (package.installDir.isNotEmpty(),
                   "shipped content '" + package.id + "' names an installDir");

        // A package offered on a platform its dependency is not would render as
        // installable there and then fail on the dependency the installer
        // resolves ahead of it — a guaranteed failure the catalogue itself can
        // rule out. `validate` refuses to publish one; this is the same rule
        // read back off the file the app actually loads.
        for (const auto& platform : { "windows-x64", "macos-arm64" })
        {
            if (! package.assetFor (platform))
                continue;

            for (auto id = package.dependsOn; id.isNotEmpty();)
            {
                const auto needed = std::find_if (
                    catalogue.packages.begin(), catalogue.packages.end(),
                    [&id] (const CataloguePackage& c) { return c.id == id; });
                if (needed == catalogue.packages.end())
                    break; // parsing already rejects an unknown id

                check (needed->assetFor (platform).has_value(),
                       "shipped package '" + package.id + "' is offered on " + platform
                           + " and so is its dependency '" + id + "'");
                id = needed->dependsOn;
            }
        }
    }

    check (! parseCatalogueNotices (text).isEmpty(), "the shipped catalogue carries notices");
    check (! parseCatalogueLinks (text).empty(), "the shipped catalogue carries links");
#endif
}

void testSignatureVerification()
{
    // A throwaway keypair: this test proves the scheme round-trips and that
    // every tampering path fails. The real signing key lives offline.
    juce::RSAKey publicKey, privateKey;
    juce::RSAKey::createKeyPair (publicKey, privateKey, 512);

    const juce::String manifest = validManifest();
    const auto* bytes = manifest.toRawUTF8();
    const auto numBytes = static_cast<size_t> (juce::CharPointer_UTF8 (bytes).sizeInBytes() - 1);

    juce::BigInteger digest;
    digest.parseString (sha256Hex (bytes, numBytes), 16);
    privateKey.applyToValue (digest);
    const auto signature = digest.toString (16);

    check (verifyManifestSignature (bytes, numBytes, signature, publicKey),
           "a correctly signed manifest verifies");

    const juce::String tampered = manifest.replace ("\"revision\": 3", "\"revision\": 4");
    const auto* tamperedBytes = tampered.toRawUTF8();
    const auto tamperedLen = static_cast<size_t> (juce::CharPointer_UTF8 (tamperedBytes).sizeInBytes() - 1);
    check (! verifyManifestSignature (tamperedBytes, tamperedLen, signature, publicKey),
           "a modified manifest fails verification");

    juce::RSAKey otherPublic, otherPrivate;
    juce::RSAKey::createKeyPair (otherPublic, otherPrivate, 512);
    check (! verifyManifestSignature (bytes, numBytes, signature, otherPublic),
           "a signature from another key fails verification");

    check (! verifyManifestSignature (bytes, numBytes, {}, publicKey),
           "a missing signature fails verification");

    // An uninitialised key must reject rather than wave anything through —
    // this is the state a build sits in before a keypair is generated.
    check (! verifyManifestSignature (bytes, numBytes, signature, juce::RSAKey()),
           "an empty key verifies nothing");
}

void testSignerInterop()
{
    // The catalogue is signed by packaging/scripts/signing.ts (Node
    // BigInt) and verified here (juce::RSAKey). Those are two independent
    // implementations of the same modular exponentiation, and a disagreement
    // about hex padding, byte order or the sign bit would not show up until a
    // published catalogue failed to verify on every user's machine at once.
    //
    // So this pins the cross-language contract with a fixture that signer
    // actually produced. Regenerating it is deliberate work, which is
    // the point: if a change here needs new numbers, the format moved.
    //
    // These numbers were regenerated once already, because a repository-wide
    // rigflow -> plectrify rename rewrote the message literal below and left
    // the signature standing over bytes that no longer existed. The keypair is
    // a throwaway generated for this test alone; it is not the catalogue key,
    // and nothing but this fixture verifies against it.
    constexpr const char* publicKey =
        "10001,a19312702f0fccc2b932259695f64f1e86a8acc00bb281b9935e6f021aae5dc1"
        "fa6afe244a3256a256a592abe195b2296cfb8411a8660f04bde8001630e31dd1ed50ac"
        "d87fc0e73d1dd540e5658af4a9ab197d3efea9d707af1290724ad9c40a867e2f07f9ce"
        "d139e13eb2056d4c1eb926257c25bb5db3ba7735d76f3bce1abaa8dadbfcb1f48d99c2"
        "a2f53dedc43a916d92f46056764eb9dece7979c0807ecd5d0166c194cd54b75b87ed64"
        "65a61c4e5b4546182f923f23407bd4177f902b7e7391ecff8a2256beaceafa102a674b"
        "146ec434e82736d05620e8782d669d29f11ec775037698002cdc90483a1660433b2901"
        "d0c106d0cfb979218a1d03eab6d5";

    constexpr const char* signature =
        "5b0721df06feea79382b3782614c828d833948bf97eb96549a28b031681b922f8c41e7"
        "c49c7a4d5f8356b59395d5e6773eafc604b8329812c2536eae4e8404ba1d2e88d730ce"
        "9ee3ef27d006f5659eb2dfcc34c8651636f294215e594e10427dadd822e8b2feb36b1c"
        "7cd2850464f23f60deb44ba530453c7b1c9d97752a112175f46ef831dd1ffe9faa8292"
        "3514c9fa5e8405bdf778201709665cf342bb4336f454be0f63426285c10f9a4c24bc1c"
        "ad76382df219b8b9994ab4baf9ff161b2262dbc6c4a8f5df86c341fa729f8f81059b5f"
        "efceb03335dfa1332fb2f088089b269ea15899b391394abe3e98905dcb62239679f57d"
        "69fd30bd5c4ca2cb742cde";

    // The literal is part of the fixture: the signature above was produced over
    // these exact bytes, so editing the wording — even to match a rename —
    // invalidates it.
    const juce::String message { "plectrify-starter-pack-signature-fixture" };
    const auto* bytes = message.toRawUTF8();
    const auto numBytes = static_cast<size_t> (message.getNumBytesAsUTF8());

    const juce::RSAKey key { juce::String (publicKey) };

    check (verifyManifestSignature (bytes, numBytes, signature, key),
           "a signature produced by the Node signer verifies in C++");

    const juce::String tampered { "plectrify-starter-pack-signature-fixtura" };
    check (! verifyManifestSignature (tampered.toRawUTF8(),
                                      static_cast<size_t> (tampered.getNumBytesAsUTF8()),
                                      signature, key),
           "that fixture signature does not verify a different message");
}

void testIncludePatterns()
{
    const juce::StringArray patterns { "**/*.vst3/**", "*.vst3" };

    check (matchesAnyIncludePattern ("ZamGate.vst3", patterns),
           "a bare .vst3 at the archive root matches");
    check (matchesAnyIncludePattern ("ZamGate.vst3/Contents/x86_64-win/ZamGate.vst3", patterns),
           "a file inside a bundle matches");
    check (matchesAnyIncludePattern ("win64/ZamGate.vst3/Contents/moduleinfo.json", patterns),
           "a bundle nested under a folder matches");

    // Archives repacked with PowerShell's Compress-Archive carry backslash
    // separators — which the re-hosting tools no longer use, but the objects
    // they produced are still live and still pinned. Without normalising, those
    // would extract nothing and fail with "the download contained no VST3
    // plugin" — exactly the shape of the real NAM archive.
    check (matchesAnyIncludePattern (R"(NeuralAmpModeler.vst3\Contents\x86_64-win\NeuralAmpModeler.vst3)", patterns),
           "a backslash-separated bundle path matches");
    check (matchesAnyIncludePattern (R"(NeuralAmpModeler.vst3\Contents\)", patterns),
           "a backslash-separated directory entry matches");

    check (! matchesAnyIncludePattern ("readme.txt", patterns), "a readme does not match");
    check (! matchesAnyIncludePattern ("setup.exe", patterns), "an installer does not match");
    check (! matchesAnyIncludePattern ("docs/manual.pdf", patterns), "a nested non-plugin does not match");

    // A single star must not cross a separator, or "*.vst3" would swallow
    // every path that merely ends in .vst3 at any depth.
    check (! matchesIncludePattern ("win64/ZamGate.vst3", "*.vst3"),
           "a single star does not cross a path separator");
    check (matchesIncludePattern ("win64/ZamGate.vst3", "**/*.vst3"),
           "a double star does cross a path separator");
}

void testArchiveEntrySafety()
{
    check (isSafeArchiveEntryName ("ZamGate.vst3/Contents/x.dll"), "an ordinary relative path is safe");

    check (! isSafeArchiveEntryName ("../evil.dll"), "a parent-directory escape is rejected");
    check (! isSafeArchiveEntryName ("a/../../evil.dll"), "a nested escape is rejected");
    check (! isSafeArchiveEntryName ("/etc/passwd"), "an absolute path is rejected");
    check (! isSafeArchiveEntryName ("C:/Windows/System32/evil.dll"), "a drive letter is rejected");
    check (! isSafeArchiveEntryName (""), "an empty name is rejected");

    // Zip entries may legally use backslashes; normalising first is what stops
    // "..\\x" reading as one harmless segment.
    check (! isSafeArchiveEntryName ("..\\evil.dll"), "a backslash escape is rejected");
}

void testSymlinkTargetSafety()
{
    // A symlink's target is the entry's content, so name checking never sees
    // it. macOS bundles carry relative links; anything that could point
    // outside what was extracted beside the link is refused.
    check (isSafeSymlinkTarget ("Versions/A/Frameworks"), "a relative target is safe");
    check (isSafeSymlinkTarget ("Foo"), "a sibling target is safe");

    check (! isSafeSymlinkTarget ("/usr/lib/libSystem.dylib"), "an absolute target is rejected");
    check (! isSafeSymlinkTarget ("../../outside"), "a parent-directory escape is rejected");
    check (! isSafeSymlinkTarget ("a/../../outside"), "a nested escape is rejected");
    check (! isSafeSymlinkTarget (""), "an empty target is rejected");
}

void testArchiveEntryExecutable()
{
    // The mode a POSIX zipper records sits in the high 16 bits. These are the
    // shapes pack.ts writes and the ones upstream's own mac releases carry.
    check (archiveEntryIsExecutable (0100755u << 16), "an executable file is executable");
    check (! archiveEntryIsExecutable (0100644u << 16), "a data file is not");

    // A zip written on Windows records nothing up there at all — and the DLL it
    // holds needs no execute bit for the loader to map it.
    check (! archiveEntryIsExecutable (0), "attributes with no Unix mode are not executable");
    check (! archiveEntryIsExecutable (0x20), "MS-DOS attributes alone are not executable");

    // chmod follows a link, so restoring +x from one would change the
    // permissions of whatever it points at instead — and a link's own 0777 is
    // meaningless. Directories are already created traversable.
    check (! archiveEntryIsExecutable (0120777u << 16), "a symlink is never executable");
    check (! archiveEntryIsExecutable (0040755u << 16), "a directory entry is not a file");

    // Some zippers write a mode with no file type; taking it at its word is
    // what stops a real Mach-O from arriving unrunnable.
    check (archiveEntryIsExecutable (0755u << 16), "a bare mode is taken at its word");
}

void testOutermostPluginPath()
{
    // Real layouts, taken from the actual release archives: every Windows VST3
    // bundle repeats its own name as the DLL inside it, so a naive "*.vst3"
    // sweep finds each plugin twice.
    check (isOutermostPluginPath ("zam-plugins-4.5/ZaMaximX2.vst3"),
           "a bundle directory is a plugin");
    check (! isOutermostPluginPath ("zam-plugins-4.5/ZaMaximX2.vst3/Contents/x86_64-win/ZaMaximX2.vst3"),
           "the DLL inside a bundle is not a second plugin");
    check (! isOutermostPluginPath ("reevr-win/VST3/REEV-R.vst3/Contents/x86_64-win/REEV-R.vst3"),
           "nesting is detected at any depth");
    check (isOutermostPluginPath ("Airwindows Consolidated.vst3"),
           "a bundle at the archive root is a plugin");
    check (! isOutermostPluginPath ("dragonfly-reverb-3.2.10/DragonflyHall.lv2/manifest.ttl"),
           "a non-plugin file is not a plugin");
    check (! isOutermostPluginPath (""), "an empty path is not a plugin");

    // The macOS bundle layout: the binary inside Contents/MacOS usually has no
    // .vst3 suffix, but archives that do repeat it must still yield one plugin.
    check (isOutermostPluginPath ("NeuralAmpModeler.vst3"),
           "a mac bundle at the archive root is a plugin");
    check (! isOutermostPluginPath ("NeuralAmpModeler.vst3/Contents/MacOS/NeuralAmpModeler"),
           "the mac binary inside a bundle is not a plugin");
    check (! isOutermostPluginPath ("NeuralAmpModeler.vst3/Contents/MacOS/NeuralAmpModeler.vst3"),
           "a suffixed mac binary inside a bundle is not a second plugin");
    check (! isOutermostPluginPath ("Surge XT.vst3/Contents/Resources/surge.svg"),
           "a resource inside a mac bundle is not a plugin");
}

void testInstalledFileNameSafety()
{
    // Uninstall deletes on the strength of a record we wrote earlier, so a
    // damaged or hand-edited marker must remove nothing rather than reach
    // outside the directory Plectrify owns.
    check (isSafeInstalledFileName ("ZamGate.vst3"), "a plain bundle name is safe to delete");

    check (! isSafeInstalledFileName ("../../Windows/System32/evil.dll"),
           "a parent-directory escape is refused");
    check (! isSafeInstalledFileName ("sub/dir/Foo.vst3"), "a nested path is refused");
    // Raw string: a plain literal would need doubled backslashes, and getting
    // that wrong makes the test assert on a name with no backslash in it at all.
    check (! isSafeInstalledFileName (R"(sub\dir\Foo.vst3)"), "a backslash path is refused");
    check (! isSafeInstalledFileName ("C:/Windows/System32/evil.dll"), "a drive letter is refused");
    check (! isSafeInstalledFileName (".."), "a bare .. is refused");
    check (! isSafeInstalledFileName (""), "an empty name is refused");
}

void testInstallMarkerDirectorySafety()
{
    // The Windows shape: content directories are siblings of the plugin
    // directory under one Plectrify root.
    const auto plectrify = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("Plectrify-marker-test");
    const auto managed = plectrify.getChildFile ("plugins");

    check (isApprovedInstallMarkerDirectory (managed.getFullPathName(), managed, plectrify, false),
           "a plugin marker may name the exact managed plugin directory");
    check (isApprovedInstallMarkerDirectory (
               plectrify.getChildFile ("patches").getFullPathName(), managed, plectrify, true),
           "a content marker may name a direct Plectrify content directory");

    check (! isApprovedInstallMarkerDirectory (
               plectrify.getChildFile ("patches").getFullPathName(), managed, plectrify, false),
           "a plugin marker may not redirect deletion into a content directory");
    check (! isApprovedInstallMarkerDirectory (
               plectrify.getChildFile ("patches/nested").getFullPathName(), managed, plectrify, true),
           "a nested directory is not an approved content root");
    check (! isApprovedInstallMarkerDirectory (
               plectrify.getParentDirectory().getChildFile ("profile").getFullPathName(), managed, plectrify, true),
           "a directory outside Plectrify is not an approved content root");
    check (! isApprovedInstallMarkerDirectory (plectrify.getFullPathName(), managed, plectrify, true),
           "Plectrify's ProgramData root itself is never a delete root");
    check (! isApprovedInstallMarkerDirectory (
               plectrify.getChildFile (".plectrify-installed").getFullPathName(), managed, plectrify, true),
           "an internal dot-directory is not an approved content root");

    // The macOS shape: the plugin directory (~/Library/Audio/Plug-Ins/VST3)
    // and the content root (/Users/Shared/Plectrify) are unrelated trees. Pure
    // path logic, so both shapes are exercised on every platform.
    const auto vst3Dir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("Plectrify-marker-test-vst3");
    const auto contentRoot = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                 .getChildFile ("Plectrify-marker-test-shared");

    check (isApprovedInstallMarkerDirectory (vst3Dir.getFullPathName(), vst3Dir, contentRoot, false),
           "split roots: a plugin marker may name the plugin directory");
    check (isApprovedInstallMarkerDirectory (
               contentRoot.getChildFile ("patches").getFullPathName(), vst3Dir, contentRoot, true),
           "split roots: a content marker may name a direct child of the content root");
    check (! isApprovedInstallMarkerDirectory (
               vst3Dir.getParentDirectory().getChildFile ("patches").getFullPathName(),
               vst3Dir, contentRoot, true),
           "split roots: the plugin directory's siblings are not content roots");
    check (! isApprovedInstallMarkerDirectory (contentRoot.getFullPathName(), vst3Dir, contentRoot, true),
           "split roots: the content root itself is never a delete root");
}

void testMayReplaceManagedPlugin()
{
    // Pure path-free logic, so both platforms' answers are exercised on either
    // machine — the macOS rule is the one that must not be relaxed by accident.
    const juce::String ours { "aaa" }, theirs { "bbb" };

    check (mayReplaceManagedPlugin (true, ours, ours, false),
           "a claimed name still matching its fingerprint is ours to replace");
    check (mayReplaceManagedPlugin (true, ours, ours, true),
           "the same holds in a directory Plectrify owns outright");

    check (! mayReplaceManagedPlugin (true, ours, theirs, false),
           "a claimed name replaced by another build is refused");
    check (! mayReplaceManagedPlugin (true, ours, theirs, true),
           "an exclusive directory does not excuse clobbering a replaced copy");

    check (mayReplaceManagedPlugin (true, {}, theirs, false),
           "a marker predating fingerprints is taken at its word");

    // The bug this rule exists for: an install killed between moving the bundle
    // and writing its marker leaves a plugin nothing accounts for. In
    // Plectrify's own ProgramData folder that can only be our own debris, and
    // refusing it made the row permanently un-installable from inside the app.
    check (mayReplaceManagedPlugin (false, {}, theirs, true),
           "an unclaimed bundle in Plectrify's own folder is leftover debris and may be replaced");
    check (! mayReplaceManagedPlugin (false, {}, theirs, false),
           "an unclaimed bundle in the user's shared VST3 folder is somebody else's plugin");
}

void testMayDeleteManagedPlugin()
{
    const juce::String ours { "aaa" }, theirs { "bbb" };

    check (mayDeleteManagedPlugin (ours, ours, false),
           "a file still matching what we recorded is ours to delete");
    check (mayDeleteManagedPlugin (ours, ours, true),
           "the same holds in a directory Plectrify owns outright");

    check (mayDeleteManagedPlugin ({}, theirs, false),
           "a record predating fingerprints removes by name as it always did");

    // The asymmetry, and the bug behind it: leaving a changed bundle behind in
    // Plectrify's own folder reports the package removed while the plugin stays
    // in the load path and in the drawer, with nothing in the app able to take
    // it out again.
    check (mayDeleteManagedPlugin (ours, theirs, true),
           "a changed copy in Plectrify's own folder is still ours to remove");
    check (! mayDeleteManagedPlugin (ours, theirs, false),
           "a changed copy in the user's shared VST3 folder is left where it is");
}

void testInstalledFileFingerprint()
{
    // The only case here that touches disk, because what it has to be right
    // about is disk: whether the Foo.vst3 sitting in the managed directory is
    // still the one Plectrify installed. On macOS that directory is the user's
    // own ~/Library/Audio/Plug-Ins/VST3, so getting this wrong means deleting
    // a plugin somebody else installed.
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("Plectrify-fingerprint-test");
    root.deleteRecursively();
    const juce::ScopeGuard cleanUp { [&root] { root.deleteRecursively(); } };

    const auto makeBundle = [] (const juce::File& bundle)
    {
        bundle.getChildFile ("Contents/x86_64-win").createDirectory();
        bundle.getChildFile ("Contents/x86_64-win/Foo.vst3").replaceWithText ("binary");
        bundle.getChildFile ("Contents/moduleinfo.json").replaceWithText ("{}");
    };

    check (installedFileFingerprint (root.getChildFile ("absent.vst3")).isEmpty(),
           "a path with nothing at it has no fingerprint");

    const auto bundle = root.getChildFile ("Foo.vst3");
    makeBundle (bundle);
    const auto original = installedFileFingerprint (bundle);

    check (original.isNotEmpty(), "an installed bundle fingerprints");
    check (installedFileFingerprint (bundle) == original,
           "fingerprinting the same bundle twice agrees");

    // The case the whole mechanism exists for: another installer's build put
    // in place of ours must not still look like ours.
    bundle.getChildFile ("Contents/x86_64-win/Foo.vst3").replaceWithText ("a different build");
    check (installedFileFingerprint (bundle) != original,
           "replacing a file inside the bundle changes the fingerprint");

    bundle.deleteRecursively();
    makeBundle (bundle);
    check (installedFileFingerprint (bundle) == original,
           "an identical bundle rebuilt in place fingerprints the same");

    const auto elsewhere = root.getChildFile ("copy/Foo.vst3");
    makeBundle (elsewhere);
    check (installedFileFingerprint (elsewhere) == original,
           "the fingerprint covers a bundle's contents, not where it sits");

    // Finder leaves these inside any folder it displays. Disowning a plugin
    // over one would be worse than not checking at all.
    bundle.getChildFile ("Contents/.DS_Store").replaceWithText ("finder");
    check (installedFileFingerprint (bundle) == original,
           "a hidden file dropped inside the bundle is ignored");

    bundle.getChildFile ("Contents/extra.dll").replaceWithText ("x");
    check (installedFileFingerprint (bundle) != original,
           "a file added to the bundle changes the fingerprint");

    // A Windows VST3 can also be a bare file rather than a bundle directory.
    const auto plain = root.getChildFile ("Bare.vst3");
    plain.replaceWithText ("dll bytes");
    const auto plainPrint = installedFileFingerprint (plain);

    check (plainPrint.isNotEmpty(), "a bare .vst3 file fingerprints");
    check (plainPrint != original, "a file and a bundle never share a fingerprint");

    plain.replaceWithText ("longer dll bytes");
    check (installedFileFingerprint (plain) != plainPrint,
           "rewriting a bare .vst3 at a different size changes the fingerprint");
}

void testSha256()
{
    // NIST's canonical empty-string digest — proves juce_cryptography is
    // actually linked and that we lowercase consistently.
    check (sha256Hex ("", 0) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
           "SHA-256 of the empty string matches the known digest");
}
} // namespace

int main()
{
    testManifestParsing();
    testPlatformAssets();
    testPackageKind();
    testDependencies();
    testBundleParsing();
    testRealCatalogueParses();
    testSignatureVerification();
    testSignerInterop();
    testIncludePatterns();
    testArchiveEntrySafety();
    testSymlinkTargetSafety();
    testArchiveEntryExecutable();
    testOutermostPluginPath();
    testInstalledFileNameSafety();
    testInstallMarkerDirectorySafety();
    testMayReplaceManagedPlugin();
    testMayDeleteManagedPlugin();
    testInstalledFileFingerprint();
    testSha256();

    if (failures != 0)
        return 1;

    std::cout << "Catalogue: all cases passed\n";
    return 0;
}
