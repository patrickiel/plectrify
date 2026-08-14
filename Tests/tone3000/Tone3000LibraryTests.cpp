#include <JuceHeader.h>

#include "Tone3000Library.h"
#include "Tone3000SelectUrl.h"
#include "Tone3000WindowState.h"

#include <iostream>

// Offline coverage for where a TONE3000 download lands and what it is called.
// Two of these rules are security-bearing — an id or a URL from the network
// must not be able to name a file outside the tone3000 root, and only two
// extensions may ever be written — and one is a compatibility contract: the
// filename is baked into every patch's plugin state, so it must be derivable
// from ids alone and must never change.

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

using namespace Tone3000Library;

void testFormats()
{
    check (formatFromString ("nam") == Format::nam, "nam is recognised");
    check (formatFromString ("IR") == Format::ir, "the format string is case-insensitive");
    check (! formatFromString ("aida-x").has_value(), "a format Plectrify cannot play is not accepted");
    check (! formatFromString ("proteus").has_value(), "nor is Proteus");
    check (! formatFromString ("").has_value(), "nor is nothing at all");
}

void testModelPaths()
{
    check (modelRelativePath (42, 7, Format::nam) == "nam/42-7.nam", "a capture's path is ids only");
    check (modelRelativePath (42, 7, Format::ir) == "ir/42-7.wav", "an IR's path is ids only");
    check (imageRelativePath (42) == "images/42.jpg", "cover art is filed by tone id");

    // The name is what every patch's plugin state will point at, so it must be
    // a function of the ids and of nothing else — no title, no creator, no
    // version. A retitled tone upstream must not move the file.
    check (modelRelativePath (42, 7, Format::nam) == modelRelativePath (42, 7, Format::nam),
           "the same tone and model always yield the same path");

    check (modelRelativePath (0, 7, Format::nam).isEmpty(), "a zero id yields no path");
    check (modelRelativePath (-1, 7, Format::nam).isEmpty(), "a negative id yields no path");
    check (modelRelativePath (42, 0, Format::nam).isEmpty(), "a zero model id yields no path");
    check (imageRelativePath (0).isEmpty(), "a zero tone id yields no image path");
}

void testRelativePathSafety()
{
    check (isSafeRelativePath ("nam/42-7.nam"), "a capture path is accepted");
    check (isSafeRelativePath ("ir/42-7.wav"), "an IR path is accepted");
    check (isSafeRelativePath ("images/42.jpg"), "an image path is accepted");

    // A patch document is read back from disk and may not be one we wrote, so
    // its `file` field is checked rather than trusted.
    check (! isSafeRelativePath ("../plugins/evil.vst3"), "a traversal is refused");
    check (! isSafeRelativePath ("nam/../../evil.dll"), "a traversal mid-path is refused");
    check (! isSafeRelativePath ("/etc/passwd"), "an absolute POSIX path is refused");
    check (! isSafeRelativePath ("C:/Windows/System32/evil.dll"), "a drive-qualified path is refused");
    check (! isSafeRelativePath ("nam\\..\\evil"), "a backslash path is refused rather than normalised");
    check (! isSafeRelativePath ("nam/sub/42-7.nam"), "the layout is exactly two segments deep");
    check (! isSafeRelativePath ("42-7.nam"), "a bare filename names no subdirectory");
    check (! isSafeRelativePath ("plugins/evil.vst3"), "only the three known subdirectories are allowed");
    check (! isSafeRelativePath (""), "an empty path is refused");
    check (! isSafeRelativePath (".hidden/x"), "a leading dot is refused, so .staging stays unreadable");
}

void testUrlExtensionAllowlist()
{
    check (urlMatchesFormat ("https://storage.example/abc/model.nam", Format::nam),
           "a .nam URL matches the capture format");
    check (urlMatchesFormat ("https://storage.example/abc/cab.wav", Format::ir),
           "a .wav URL matches the IR format");

    check (! urlMatchesFormat ("https://storage.example/abc/model.nam", Format::ir),
           "a capture is not accepted into the IR slot");
    check (! urlMatchesFormat ("https://storage.example/abc/evil.dll", Format::nam),
           "an executable extension is refused");
    check (! urlMatchesFormat ("https://storage.example/abc/evil.exe", Format::ir),
           "so is an executable in the IR slot");
    check (! urlMatchesFormat ("https://storage.example/abc/model", Format::nam),
           "a URL with no extension is refused");

    // A signed storage URL keeps its token in the query, and those are full of
    // dots and slashes. The extension check must read the path alone.
    check (urlMatchesFormat ("https://storage.example/abc/model.nam?token=a.b.c&x=/y.exe", Format::nam),
           "a signing query does not confuse the extension check");
    check (! urlMatchesFormat ("https://storage.example/abc/model.exe?x=y.nam", Format::nam),
           "nor can a query smuggle an acceptable extension past it");
}

void testGarbageCollection()
{
    const juce::StringArray present { "nam/1-1.nam", "nam/2-2.nam", "ir/3-3.wav" };
    const juce::StringArray referenced { "nam/2-2.nam" };

    const auto unused = unreferencedFiles (present, referenced);

    check (unused.size() == 2 && unused.contains ("nam/1-1.nam") && unused.contains ("ir/3-3.wav"),
           "files no patch names are reported as unused");
    check (! unused.contains ("nam/2-2.nam"), "a referenced file is never reported");

    check (unreferencedFiles ({}, referenced).isEmpty(), "an empty root reports nothing");
    check (unreferencedFiles (present, {}).size() == 3,
           "with no patches at all, everything is unused — reported, never deleted here");
}

void testRoot()
{
    const juce::File contentRoot { juce::File::getCurrentWorkingDirectory().getChildFile ("Plectrify") };
    check (rootDirectory (contentRoot).getFileName() == "tone3000",
           "downloads sit in their own folder beside the catalogue's installs");
}
//==============================================================================
// Which model of a tone is downloaded when nobody is asked. Plectrify picks
// rather than prompting, so the rule has to be stateable — these cases *are*
// the statement.
void testModelChoice()
{
    // juce::Array has no initializer-list constructor for an aggregate, so the
    // cases are written as lists and copied in.
    const auto choose = [] (std::initializer_list<ModelChoice> models, const juce::String& preferred)
    {
        juce::Array<ModelChoice> array;

        for (const auto& model : models)
            array.add (model);

        return chooseModel (array, preferred);
    };

    check (choose ({}, "2") == -1, "nothing to pick from is not a pick");

    check (choose ({ { 5, "2", "standard" } }, "2") == 0, "one model is the answer");

    check (choose ({ { 5, "1", "standard" }, { 6, "2", "xl" } }, "2") == 1,
           "the asked-for architecture wins even against a better size — the other "
           "generation may not load at all");

    check (choose ({ { 5, "2", "lite" }, { 6, "2", "standard" } }, "2") == 1,
           "within one architecture, standard is the weight NAM's defaults assume");

    check (choose ({ { 5, "2", "standard" }, { 6, "2", "xl" } }, "2") == 0,
           "xl loses despite being the most faithful: this runs in the audio callback");

    check (choose ({ { 9, "2", "standard" }, { 4, "2", "standard" } }, "2") == 1,
           "a tie goes to the lowest id, so two merged API pages cannot change the answer");

    check (choose ({ { 5, "1", "lite" }, { 6, "1", "standard" } }, "2") == 1,
           "with no architecture matching, size still decides rather than order");

    check (choose ({ { 5, "2", "brand-new-size" }, { 6, "2", "nano" } }, "2") == 1,
           "an unknown size ranks last but is still loadable — TONE3000 may add one");
}

//==============================================================================
// Where the TONE3000 window opens. The interesting cases are all about a
// display that is no longer there, which is exactly what cannot be tested by
// opening a window.
void testWindowPlacement()
{
    using namespace Tone3000WindowState;

    const juce::Rectangle<int> primary { 0, 0, 1920, 1080 };
    const juce::Rectangle<int> secondary { 1920, 0, 1920, 1080 };
    const juce::Rectangle<int> fallback { 400, 200, 1100, 820 };

    const auto saved = [] (int x, int y, int w, int h)
    { return Bounds { x, y, w, h, false }; };

    const auto displays = [] (std::initializer_list<juce::Rectangle<int>> areas)
    {
        juce::Array<juce::Rectangle<int>> array;

        for (const auto& area : areas)
            array.add (area);

        return array;
    };

    check (place ({}, displays ({ primary }), fallback) == fallback,
           "nothing saved yet opens at the default placement");

    check (place (saved (100, 100, 900, 700), {}, fallback) == fallback,
           "no displays reported at all falls back rather than guessing");

    check (place (saved (7, 30, 128, 128), displays ({ primary }), fallback) == fallback,
           "a stub size is not a window anyone sat in front of — this is the artefact a "
           "teardown resize used to write, and it must not be restorable");

    check (place (saved (100, 100, 900, 700), displays ({ primary }), fallback)
               == juce::Rectangle<int> { 100, 100, 900, 700 },
           "a window still on its display comes back exactly where it was");

    check (place (saved (2000, 100, 900, 700), displays ({ primary, secondary }), fallback)
               == juce::Rectangle<int> { 2000, 100, 900, 700 },
           "the second monitor is remembered as such, not folded onto the first");

    check (place (saved (2000, 100, 900, 700), displays ({ primary }), fallback) == fallback,
           "the monitor it was left on has been unplugged — centre it instead of "
           "opening off the edge of the desktop");

    check (place (saved (1700, 100, 600, 500), displays ({ primary, secondary }), fallback)
               == juce::Rectangle<int> { 1700, 100, 600, 500 },
           "a window deliberately straddling two monitors is left alone");

    const juce::Rectangle<int> laptop { 0, 0, 1280, 800 };
    const auto shrunk = place (saved (0, 0, 1900, 1000), displays ({ laptop }), fallback);
    check (shrunk.getWidth() <= laptop.getWidth() && shrunk.getHeight() <= laptop.getHeight(),
           "a window saved on a 4K screen must not come back bigger than the laptop it "
           "is reopened on");

    const auto restored = place (Bounds { 10, 20, 900, 700, true }, displays ({ primary }), fallback);
    check (restored == juce::Rectangle<int> { 10, 20, 900, 700 },
           "the maximised flag travels separately: the rectangle stored is the size to "
           "come back down to");
}
//==============================================================================
// Reopening on the page the user was reading. The rule that matters is that the
// single-use half of a Select URL is never carried forward, and the rule that
// makes it work at all is that the other half is.
void testSelectUrls()
{
    using namespace Tone3000SelectUrl;

    const juce::String base { "https://www.tone3000.com" };
    const juce::String tone { "https://www.tone3000.com/api/v1/select/tones/02-vox-ac306-70408"
                              "?authorization_id=nocfnrud4qd5rt4v2spkhxw44qnro3rl" };
    const juce::String filtered { "https://www.tone3000.com/api/v1/select"
                                  "?creators=akka5&authorization_id=abc123" };

    check (isSelectPage (tone, base), "a tone page inside the flow is a page we know");
    check (isSelectPage (filtered, base), "so is a filtered list");
    check (! isSelectPage ("https://www.tone3000.com/tones/12345", base),
           "their public site is not this flow");
    check (! isSelectPage ("https://www.tone3000.com/api/v1/selection?x=1", base),
           "matched with the separator, so a longer path that merely starts the same way "
           "is not mistaken for a page of this flow");
    check (! isSelectPage ("https://plectrify.com/oauth/tone3000?code=abc", base),
           "our own redirect is not somewhere to reopen on");

    check (placeOf (tone, base) == "/api/v1/select/tones/02-vox-ac306-70408",
           "the place is the path, with the single-use authorization taken out");
    check (placeOf (filtered, base) == "/api/v1/select?creators=akka5",
           "filters are part of where the user was and are kept");
    check (placeOf ("https://www.tone3000.com/tones/1", base).isEmpty(),
           "anything outside the flow has no place to remember");

    check (authorizationIdOf (filtered) == "abc123", "the live authorization is read back");
    check (authorizationIdOf ("https://www.tone3000.com/api/v1/select").isEmpty(),
           "a flow that has not landed yet has none, which is a reason to wait");

    check (urlForPlace (base, placeOf (tone, base), "fresh")
               == "https://www.tone3000.com/api/v1/select/tones/02-vox-ac306-70408"
                  "?authorization_id=fresh",
           "the remembered page is rebuilt inside the *new* flow");
    check (urlForPlace (base, placeOf (filtered, base), "fresh")
               == "https://www.tone3000.com/api/v1/select?creators=akka5&authorization_id=fresh",
           "an existing query is appended to, not replaced");

    check (urlForPlace (base, "/api/v1/select/tones/1", {}).isEmpty(),
           "no authorization means no URL: never send the window somewhere it cannot be");
    check (urlForPlace (base, {}, "fresh").isEmpty(), "and no place means nothing to restore");
    check (urlForPlace (base, "/somewhere/else", "fresh").isEmpty(),
           "a place read back from disk cannot send the window outside the flow carrying a "
           "live authorization");
}
} // namespace

int main()
{
    testFormats();
    testModelPaths();
    testRelativePathSafety();
    testUrlExtensionAllowlist();
    testGarbageCollection();
    testRoot();
    testModelChoice();
    testWindowPlacement();
    testSelectUrls();

    if (failures != 0)
        return 1;

    std::cout << "Tone3000Library: all cases passed\n";
    return 0;
}
