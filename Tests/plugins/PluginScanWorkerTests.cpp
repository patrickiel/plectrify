#include <JuceHeader.h>

#include "PluginScanWorker.h"

#include <iostream>

/*
    The protocol between the app and its plugin-scan worker process: how a
    worker recognises its own command line, and the request/reply codec. Pure
    functions only — no process is launched here; every scan the standalone
    runs exercises that.
*/

namespace
{
using namespace plectrify::scanworker;

int failures = 0;

void check (bool condition, const juce::String& what)
{
    if (! condition)
    {
        ++failures;
        std::cerr << "FAIL " << what << "\n";
    }
}

juce::PluginDescription makeDescription (const juce::String& name, const juce::String& file, int uid)
{
    juce::PluginDescription d;
    d.name = name;
    d.descriptiveName = name + " (long)";
    d.pluginFormatName = "VST3";
    d.category = "Fx";
    d.manufacturerName = "Someone";
    d.version = "1.2.3";
    d.fileOrIdentifier = file;
    d.lastFileModTime = juce::Time (1700000000000);
    d.lastInfoUpdateTime = juce::Time (1700000001000);
    d.deprecatedUid = uid;
    d.uniqueId = uid * 7;
    d.isInstrument = false;
    d.numInputChannels = 2;
    d.numOutputChannels = 2;
    d.hasSharedContainer = false;
    d.hasARAExtension = false;
    return d;
}

void testCommandLine()
{
    const auto prefix = "--" + juce::String (commandLineId) + ":";

    check (isWorkerCommandLine (prefix + "p1a2b3c4"), "a coordinator's launch is recognised");
    check (isWorkerCommandLine ("  " + prefix + "pX  "), "surrounding whitespace is ignored, as JUCE ignores it");
    check (! isWorkerCommandLine (""), "an ordinary launch is not a worker");
    check (! isWorkerCommandLine ("--plectrify-after-reset"), "the reset relaunch is not a worker");
    check (! isWorkerCommandLine ("--" + juce::String (commandLineId)), "the id alone, with no pipe, is not a worker");
    check (! isWorkerCommandLine ("C:\\rig.rig " + prefix + "p1"), "the marker counts only at the front, where JUCE puts it");
}

void testRequestRoundTrip()
{
    const Request original { "VST3",
                             juce::String::fromUTF8 ("C:\\Program Files\\Common Files\\VST3\\Amp \xC3\xBC.vst3") };
    const auto decoded = decodeRequest (encodeRequest (original));

    check (decoded.has_value(), "a request decodes");
    if (decoded.has_value())
    {
        check (decoded->formatName == original.formatName, "format name survives");
        check (decoded->fileOrIdentifier == original.fileOrIdentifier, "path survives, non-ASCII included");
    }

    const Request legacy { "VST", "/home/me/.vst/Thing.so" };
    const auto decodedLegacy = decodeRequest (encodeRequest (legacy));
    check (decodedLegacy.has_value() && decodedLegacy->formatName == "VST", "the older format's name is just a string");
}

void testRequestRejectsNoise()
{
    check (! decodeRequest ({}).has_value(), "an empty block is not a request");

    const char noise[] = "definitely not a request\0with a zero\0inside";
    check (! decodeRequest (juce::MemoryBlock (noise, sizeof (noise))).has_value(), "text is not a request");

    check (! decodeRequest (encodeRequest ({ "", "C:\\x.vst3" })).has_value(), "a request needs a format");
    check (! decodeRequest (encodeRequest ({ "VST3", "" })).has_value(), "a request needs a file");

    auto truncated = encodeRequest ({ "VST3", "C:\\x.vst3" });
    truncated.setSize (truncated.getSize() - 3);
    check (! decodeRequest (truncated).has_value(), "a truncated request is rejected");

    auto padded = encodeRequest ({ "VST3", "C:\\x.vst3" });
    padded.append ("!", 1);
    check (! decodeRequest (padded).has_value(), "trailing bytes are rejected");

    // A results block must not pass for a request, nor the other way round.
    juce::OwnedArray<juce::PluginDescription> none;
    check (! decodeRequest (encodeResults (none)).has_value(), "a reply is not a request");
    juce::OwnedArray<juce::PluginDescription> sink;
    check (! decodeResults (encodeRequest ({ "VST3", "x" }), sink), "a request is not a reply");
    check (sink.isEmpty(), "a rejected reply adds nothing");
}

void testResultsRoundTrip()
{
    juce::OwnedArray<juce::PluginDescription> found;
    found.add (new juce::PluginDescription (makeDescription ("Amp", "C:\\VST3\\Amp.vst3", 101)));
    found.add (new juce::PluginDescription (makeDescription ("Cab", "C:\\VST3\\Suite.vst3", 202)));
    found.getLast()->isInstrument = true;
    found.getLast()->hasSharedContainer = true;   // a shell's members share one file

    juce::OwnedArray<juce::PluginDescription> decoded;
    decoded.add (new juce::PluginDescription (makeDescription ("Already there", "C:\\x.vst3", 1)));

    check (decodeResults (encodeResults (found), decoded), "a reply decodes");
    check (decoded.size() == 3, "decoded descriptions are appended to what was there — got " + juce::String (decoded.size()));

    if (decoded.size() == 3)
    {
        for (int i = 0; i < found.size(); ++i)
        {
            const auto& a = *found[i];
            const auto& b = *decoded[i + 1];
            check (b.isDuplicateOf (a), a.name + " matches by identity");
            check (b.name == a.name && b.descriptiveName == a.descriptiveName, a.name + ": names survive");
            check (b.pluginFormatName == a.pluginFormatName, a.name + ": format survives");
            check (b.fileOrIdentifier == a.fileOrIdentifier, a.name + ": path survives");
            check (b.uniqueId == a.uniqueId && b.deprecatedUid == a.deprecatedUid, a.name + ": both ids survive");
            check (b.isInstrument == a.isInstrument, a.name + ": instrument flag survives");
            check (b.hasSharedContainer == a.hasSharedContainer, a.name + ": shell flag survives");
            check (b.numInputChannels == a.numInputChannels && b.numOutputChannels == a.numOutputChannels,
                   a.name + ": channel counts survive");
            check (b.lastFileModTime == a.lastFileModTime, a.name + ": file time survives (what decides a rescan)");
            check (b.manufacturerName == a.manufacturerName && b.version == a.version && b.category == a.category,
                   a.name + ": the rest survives");
        }
    }
}

void testEmptyResults()
{
    // A file that loads and holds no plugin is a valid, empty answer — the
    // difference between "nothing in it" and "it crashed" is the whole point.
    juce::OwnedArray<juce::PluginDescription> none, decoded;
    check (decodeResults (encodeResults (none), decoded), "an empty reply decodes");
    check (decoded.isEmpty(), "an empty reply adds nothing");
}

void testResultsRejectNoise()
{
    juce::OwnedArray<juce::PluginDescription> decoded;
    check (! decodeResults ({}, decoded), "an empty block is not a reply");

    const char text[] = "<LIST><PLUGIN name='x'/></LIST>";
    check (! decodeResults (juce::MemoryBlock (text, sizeof (text) - 1), decoded), "another root tag is not a reply");

    const char broken[] = "<PLECTRIFY_SCAN_RESULTS><PLUGIN";
    check (! decodeResults (juce::MemoryBlock (broken, sizeof (broken) - 1), decoded), "unterminated XML is not a reply");

    const char wrongChild[] = "<PLECTRIFY_SCAN_RESULTS><NOT_A_PLUGIN name='x'/></PLECTRIFY_SCAN_RESULTS>";
    check (! decodeResults (juce::MemoryBlock (wrongChild, sizeof (wrongChild) - 1), decoded),
           "a child that is not a description fails the whole reply");

    check (decoded.isEmpty(), "nothing is appended for a rejected reply");
}

void testHello()
{
    const auto decoded = decodeHello (encodeHello (41'872));
    check (decoded.has_value() && *decoded == 41'872, "a hello carries the process id");

    const auto wide = decodeHello (encodeHello (juce::int64 (1) << 40));
    check (wide.has_value() && *wide == (juce::int64 (1) << 40), "a process id wider than 32 bits survives");

    check (! decodeHello ({}).has_value(), "an empty block is not a hello");
    check (! decodeHello (encodeHello (0)).has_value(), "a hello needs a real process id");
    check (! decodeHello (encodeHello (-5)).has_value(), "a negative process id is noise");

    auto padded = encodeHello (7);
    padded.append ("!", 1);
    check (! decodeHello (padded).has_value(), "trailing bytes are rejected");

    // The three message kinds never pass for one another: the app tells a
    // hello from a reply by decoding, and a reply must not be swallowed as one.
    check (! decodeHello (encodeRequest ({ "VST3", "x" })).has_value(), "a request is not a hello");
    juce::OwnedArray<juce::PluginDescription> none;
    check (! decodeHello (encodeResults (none)).has_value(), "a reply is not a hello");
    juce::OwnedArray<juce::PluginDescription> sink;
    check (! decodeResults (encodeHello (7), sink) && sink.isEmpty(), "a hello is not a reply");
    check (! decodeRequest (encodeHello (7)).has_value(), "a hello is not a request");
}

void testTimeouts()
{
    check (connectionTimeoutMs > fileTimeoutMs,
           "the worker's ping timeout outlasts a plugin load, or a slow plugin is mistaken for a dead app");
    check (fileTimeoutMs >= 30'000, "a large plugin's first load is allowed its time");
}
}

int main()
{
    // The XML codec goes through juce::XmlElement and PluginDescription alone;
    // no message manager is needed for either.
    testCommandLine();
    testRequestRoundTrip();
    testRequestRejectsNoise();
    testResultsRoundTrip();
    testEmptyResults();
    testResultsRejectNoise();
    testHello();
    testTimeouts();

    if (failures == 0)
        std::cout << "PluginScanWorker: all tests passed\n";
    else
        std::cerr << "PluginScanWorker: " << failures << " failure(s)\n";

    return failures == 0 ? 0 : 1;
}
