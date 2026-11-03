#include <JuceHeader.h>

#include "PluginBinary.h"

#include <iostream>
#include <vector>

/*
    The header sniffing behind "Skipped plugins" reasons. Synthetic headers
    only — ctest stays free of third-party binaries — built byte by byte from
    the PE, ELF and Mach-O layouts so a misread offset fails here rather than
    reporting a loadable plugin as 32-bit.
*/

namespace
{
using plectrify::pluginbinary::Architecture;
using plectrify::pluginbinary::describeBinaryArchitecture;
using plectrify::pluginbinary::whyUnloadable;

int failures = 0;

void check (bool condition, const juce::String& what)
{
    if (! condition)
    {
        ++failures;
        std::cerr << "FAIL " << what << "\n";
    }
}

const char* name (Architecture a)
{
    switch (a)
    {
        case Architecture::unknown:   return "unknown";
        case Architecture::bits32:    return "bits32";
        case Architecture::x64:       return "x64";
        case Architecture::arm64:     return "arm64";
        case Architecture::universal: return "universal";
    }
    return "?";
}

Architecture describe (const std::vector<juce::uint8>& bytes)
{
    juce::MemoryInputStream in (bytes.data(), bytes.size(), false);
    return describeBinaryArchitecture (in);
}

void expectArch (const std::vector<juce::uint8>& bytes, Architecture expected, const juce::String& what)
{
    const auto actual = describe (bytes);
    check (actual == expected, what + " — got " + name (actual) + ", expected " + name (expected));
}

void putLE32 (std::vector<juce::uint8>& v, size_t at, juce::uint32 x)
{
    for (int i = 0; i < 4; ++i) v[at + (size_t) i] = (juce::uint8) (x >> (8 * i));
}

void putBE32 (std::vector<juce::uint8>& v, size_t at, juce::uint32 x)
{
    for (int i = 0; i < 4; ++i) v[at + (size_t) i] = (juce::uint8) (x >> (8 * (3 - i)));
}

void putLE16 (std::vector<juce::uint8>& v, size_t at, juce::uint16 x)
{
    v[at] = (juce::uint8) x;
    v[at + 1] = (juce::uint8) (x >> 8);
}

/** A DOS stub whose PE header sits at `peOffset`, with the given Machine. */
std::vector<juce::uint8> pe (juce::uint16 machine, juce::uint32 peOffset = 0x80)
{
    std::vector<juce::uint8> v (peOffset + 24, 0);
    v[0] = 'M'; v[1] = 'Z';
    putLE32 (v, 0x3C, peOffset);
    v[peOffset] = 'P'; v[peOffset + 1] = 'E';
    putLE16 (v, peOffset + 4, machine);
    return v;
}

std::vector<juce::uint8> elf (juce::uint8 elfClass, juce::uint16 machine, bool bigEndian = false)
{
    std::vector<juce::uint8> v (64, 0);
    v[0] = 0x7F; v[1] = 'E'; v[2] = 'L'; v[3] = 'F';
    v[4] = elfClass;
    v[5] = bigEndian ? 2 : 1;
    if (bigEndian) { v[0x12] = (juce::uint8) (machine >> 8); v[0x13] = (juce::uint8) machine; }
    else           putLE16 (v, 0x12, machine);
    return v;
}

std::vector<juce::uint8> machO (juce::uint32 magic, juce::uint32 cputype)
{
    std::vector<juce::uint8> v (32, 0);
    putLE32 (v, 0, magic);     // as written by a little-endian Mac
    putLE32 (v, 4, cputype);
    return v;
}

std::vector<juce::uint8> fat (std::initializer_list<juce::uint32> cputypes)
{
    std::vector<juce::uint8> v (8 + 20 * cputypes.size(), 0);
    putBE32 (v, 0, 0xCAFEBABE);
    putBE32 (v, 4, (juce::uint32) cputypes.size());
    size_t at = 8;
    for (auto t : cputypes) { putBE32 (v, at, t); at += 20; }
    return v;
}

void testPE()
{
    expectArch (pe (0x8664), Architecture::x64, "PE AMD64");
    expectArch (pe (0x014C), Architecture::bits32, "PE i386");
    expectArch (pe (0xAA64), Architecture::arm64, "PE ARM64");
    expectArch (pe (0x01C4), Architecture::bits32, "PE ARMNT");
    expectArch (pe (0x0200), Architecture::unknown, "PE IA64 is not a machine we know");
    expectArch (pe (0x014C, 0x1000), Architecture::bits32, "a long DOS stub is followed to its PE header");

    auto bad = pe (0x8664);
    bad[0x80] = 'X';
    expectArch (bad, Architecture::unknown, "MZ without a PE signature is not an executable");

    auto truncated = pe (0x8664);
    truncated.resize (0x82);
    expectArch (truncated, Architecture::unknown, "a file ending inside its PE header is unknown");
}

void testELF()
{
    expectArch (elf (2, 0x3E), Architecture::x64, "ELF64 x86_64");
    expectArch (elf (2, 0xB7), Architecture::arm64, "ELF64 aarch64");
    expectArch (elf (1, 0x03), Architecture::bits32, "ELF32 i386");
    expectArch (elf (1, 0x28), Architecture::bits32, "ELF32 arm");
    expectArch (elf (2, 0xF3), Architecture::unknown, "ELF64 riscv is 64-bit but no host of ours");
    expectArch (elf (2, 0xB7, true), Architecture::arm64, "a big-endian ELF header reads its machine big-endian");
    expectArch (elf (3, 0x3E), Architecture::unknown, "an invalid EI_CLASS is unknown");
}

void testMachO()
{
    expectArch (machO (0xFEEDFACF, 0x01000007), Architecture::x64, "Mach-O 64 x86_64");
    expectArch (machO (0xFEEDFACF, 0x0100000C), Architecture::arm64, "Mach-O 64 arm64");
    expectArch (machO (0xFEEDFACE, 7), Architecture::bits32, "Mach-O 32 is 32-bit whatever the cpu");
    expectArch (machO (0xFEEDFACF, 0x01000012), Architecture::unknown, "ppc64 is unknown");

    expectArch (fat ({ 0x01000007, 0x0100000C }), Architecture::universal, "fat x86_64 + arm64 is universal");
    expectArch (fat ({ 7, 0x01000007 }), Architecture::x64, "fat i386 + x86_64 reads as x64");
    expectArch (fat ({ 0x0100000C }), Architecture::arm64, "fat arm64 alone");
    expectArch (fat ({ 7, 18 }), Architecture::bits32, "fat i386 + ppc is 32-bit");

    // A Java class file shares the fat magic; its minor/major version would
    // read as an absurd architecture count.
    std::vector<juce::uint8> javaClass (16, 0);
    putBE32 (javaClass, 0, 0xCAFEBABE);
    putBE32 (javaClass, 4, 0x00000041);
    expectArch (javaClass, Architecture::unknown, "a Java class file is not a fat binary");
}

void testGarbage()
{
    expectArch ({}, Architecture::unknown, "an empty file is unknown");
    expectArch ({ 'R', 'I', 'F', 'F', 0, 0, 0, 0 }, Architecture::unknown, "a WAV is unknown");
    expectArch ({ '{', '"', 'a', '"', ':', '1', '}' }, Architecture::unknown, "JSON is unknown");
}

void testReason()
{
    check (whyUnloadable (Architecture::bits32, Architecture::x64) == "bits32", "32-bit in a 64-bit host");
    check (whyUnloadable (Architecture::bits32, Architecture::arm64) == "bits32", "32-bit on Apple Silicon");
    check (whyUnloadable (Architecture::x64, Architecture::arm64) == "wrongArch", "Intel-only on Apple Silicon");
    check (whyUnloadable (Architecture::arm64, Architecture::x64) == "wrongArch", "arm64 on an x64 host");
    check (whyUnloadable (Architecture::x64, Architecture::x64).isEmpty(), "a matching binary is not reported");
    check (whyUnloadable (Architecture::universal, Architecture::arm64).isEmpty(), "a universal binary fits every host");
    check (whyUnloadable (Architecture::unknown, Architecture::x64).isEmpty(),
           "nothing confident to say means nothing said");
}

void testBundleBinary()
{
    using plectrify::pluginbinary::pluginBinaryOf;

    const auto scratch = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("PlectrifyPluginBinaryTests");
    scratch.deleteRecursively();

    const auto macBundle = scratch.getChildFile ("Amp.vst");
    macBundle.getChildFile ("Contents/Resources").createDirectory();
    macBundle.getChildFile ("Contents/MacOS").createDirectory();
    macBundle.getChildFile ("Contents/Resources/Info.plist").replaceWithText ("<plist/>");
    macBundle.getChildFile ("Contents/MacOS/Amp").replaceWithText ("binary");
    check (pluginBinaryOf (macBundle) == macBundle.getChildFile ("Contents/MacOS/Amp"),
           "a mac bundle's binary is under Contents/MacOS, never Resources");

    const auto vst3Bundle = scratch.getChildFile ("Amp.vst3");
    vst3Bundle.getChildFile ("Contents/Resources").createDirectory();
    vst3Bundle.getChildFile ("Contents/x86-win").createDirectory();
    vst3Bundle.getChildFile ("Contents/Resources/moduleinfo.json").replaceWithText ("{}");
    vst3Bundle.getChildFile ("Contents/x86-win/Amp.vst3").replaceWithText ("binary");
    check (pluginBinaryOf (vst3Bundle) == vst3Bundle.getChildFile ("Contents/x86-win/Amp.vst3"),
           "a VST3 bundle's binary is in its architecture folder");

    const auto plain = scratch.getChildFile ("Amp.dll");
    plain.replaceWithText ("binary");
    check (pluginBinaryOf (plain) == plain, "a plain file is its own binary");

    check (! pluginBinaryOf (scratch.getChildFile ("Missing.vst")).exists(), "nothing for a missing path");

    const auto empty = scratch.getChildFile ("Empty.vst3");
    empty.getChildFile ("Contents").createDirectory();
    check (! pluginBinaryOf (empty).exists(), "nothing for a bundle with no binary");

    scratch.deleteRecursively();
}
} // namespace

int main()
{
    testPE();
    testELF();
    testMachO();
    testGarbage();
    testReason();
    testBundleBinary();

    if (failures == 0)
        std::cout << "PluginBinary tests passed\n";

    return failures == 0 ? 0 : 1;
}
