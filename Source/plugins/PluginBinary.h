#pragma once

#include <JuceHeader.h>

/**
    Why a plugin file the scanner found produced no plugin.

    JUCE's scanner is silent about a binary it cannot load: a 32-bit .dll in a
    64-bit host, an Intel-only .vst bundle on Apple Silicon, yields no types, no
    error and no blacklist entry — the plugin simply is not in the drawer, and
    the user has nothing to go on. These are pure functions over the first few
    bytes of the file (PE, ELF and Mach-O headers, fat Mach-O included) that
    give the one answer we can give with confidence: the architecture the
    binary was built for, and whether that is why it did not load.

    Deliberately confident or silent. A 64-bit file of the right architecture
    that still yields nothing may be a helper library beside a plugin (common in
    older plugin folders), a dependency that failed to resolve, or a broken
    plugin — nothing here can tell, so it is not reported at all rather than
    reported with a guess.

    Pure and allocation-light: read from a stream, so the CTest feeds synthetic
    headers. Any thread.
*/
namespace plectrify::pluginbinary
{

enum class Architecture
{
    unknown,     ///< Not a recognised executable, or an unrecognised machine.
    bits32,      ///< Any 32-bit machine (i386, 32-bit ARM, 32-bit PowerPC…).
    x64,
    arm64,
    universal    ///< A fat Mach-O carrying both x86_64 and arm64.
};

/** The architecture this process was built for — the one a plugin must match. */
inline Architecture hostArchitecture()
{
   #if JUCE_ARM && JUCE_64BIT
    return Architecture::arm64;
   #elif JUCE_64BIT
    return Architecture::x64;
   #else
    return Architecture::bits32;
   #endif
}

namespace detail
{
    inline juce::uint32 readLE32 (const juce::uint8* p) noexcept
    {
        return (juce::uint32) p[0] | ((juce::uint32) p[1] << 8) | ((juce::uint32) p[2] << 16) | ((juce::uint32) p[3] << 24);
    }

    inline juce::uint32 readBE32 (const juce::uint8* p) noexcept
    {
        return ((juce::uint32) p[0] << 24) | ((juce::uint32) p[1] << 16) | ((juce::uint32) p[2] << 8) | (juce::uint32) p[3];
    }

    inline juce::uint16 readLE16 (const juce::uint8* p) noexcept
    {
        return (juce::uint16) (p[0] | (p[1] << 8));
    }

    inline juce::uint16 readBE16 (const juce::uint8* p) noexcept
    {
        return (juce::uint16) ((p[0] << 8) | p[1]);
    }

    /** Mach-O cputype → architecture. CPU_ARCH_ABI64 is 0x01000000. */
    inline Architecture machCpuType (juce::uint32 cputype) noexcept
    {
        switch (cputype)
        {
            case 0x01000007: return Architecture::x64;      // CPU_TYPE_X86_64
            case 0x0100000C: return Architecture::arm64;    // CPU_TYPE_ARM64
            case 7:                                          // CPU_TYPE_X86
            case 12:                                         // CPU_TYPE_ARM
            case 18:                                         // CPU_TYPE_POWERPC
                return Architecture::bits32;
            case 0x01000012: return Architecture::unknown;   // CPU_TYPE_POWERPC64: 64-bit, but no host of ours
            default:         return Architecture::unknown;
        }
    }

    inline bool readExactly (juce::InputStream& in, juce::uint8* dest, int count)
    {
        return in.read (dest, count) == count;
    }
}

/** Reads the executable header at the start of `in` (positioned at offset 0)
    and names its architecture. Never reads more than a few hundred bytes; the
    stream may be as short as the file is. */
inline Architecture describeBinaryArchitecture (juce::InputStream& in)
{
    using namespace detail;

    juce::uint8 head[64] = {};
    const auto got = in.read (head, (int) sizeof (head));
    if (got < 4)
        return Architecture::unknown;

    // --- PE (Windows .dll / single-file .vst3) --------------------------------
    if (head[0] == 'M' && head[1] == 'Z')
    {
        if (got < 64)
            return Architecture::unknown;

        const auto peOffset = readLE32 (head + 0x3C);
        if (peOffset < 0x40 || peOffset > 0x10000000)   // past the DOS stub, within any sane file
            return Architecture::unknown;

        if (! in.setPosition ((juce::int64) peOffset))
            return Architecture::unknown;

        juce::uint8 pe[6] = {};
        if (! readExactly (in, pe, 6) || pe[0] != 'P' || pe[1] != 'E' || pe[2] != 0 || pe[3] != 0)
            return Architecture::unknown;

        switch (readLE16 (pe + 4))     // IMAGE_FILE_HEADER.Machine
        {
            case 0x8664: return Architecture::x64;      // IMAGE_FILE_MACHINE_AMD64
            case 0xAA64: return Architecture::arm64;    // IMAGE_FILE_MACHINE_ARM64
            case 0x014C:                                 // I386
            case 0x01C0:                                 // ARM
            case 0x01C4:                                 // ARMNT (Thumb-2)
                return Architecture::bits32;
            default:     return Architecture::unknown;
        }
    }

    // --- ELF (Linux .so) --------------------------------------------------------
    if (head[0] == 0x7F && head[1] == 'E' && head[2] == 'L' && head[3] == 'F')
    {
        if (got < 0x14)
            return Architecture::unknown;

        const auto elfClass = head[4];     // EI_CLASS: 1 = 32-bit, 2 = 64-bit
        const auto elfData  = head[5];     // EI_DATA:  1 = little, 2 = big endian
        if (elfClass == 1)
            return Architecture::bits32;
        if (elfClass != 2)
            return Architecture::unknown;

        const auto machine = elfData == 2 ? readBE16 (head + 0x12) : readLE16 (head + 0x12);
        switch (machine)
        {
            case 0x3E: return Architecture::x64;      // EM_X86_64
            case 0xB7: return Architecture::arm64;    // EM_AARCH64
            default:   return Architecture::unknown;  // 64-bit, but not a machine we run on
        }
    }

    // --- Mach-O (macOS .vst / .vst3 / .component binary) ------------------------
    const auto magicBE = readBE32 (head);
    const auto magicLE = readLE32 (head);

    // Thin. 0xFEEDFACE is the 32-bit header, 0xFEEDFACF the 64-bit; a file
    // written on a little-endian machine stores them byte-swapped.
    if (magicLE == 0xFEEDFACE || magicBE == 0xFEEDFACE)
        return Architecture::bits32;
    if (magicLE == 0xFEEDFACF || magicBE == 0xFEEDFACF)
    {
        if (got < 8)
            return Architecture::unknown;
        const auto cputype = magicLE == 0xFEEDFACF ? readLE32 (head + 4) : readBE32 (head + 4);
        return machCpuType (cputype);
    }

    // Fat: always big-endian. 0xCAFEBABE (32-bit arch table) or 0xCAFEBABF.
    if (magicBE == 0xCAFEBABE || magicBE == 0xCAFEBABF)
    {
        if (got < 8)
            return Architecture::unknown;

        const auto count = readBE32 (head + 4);
        if (count == 0 || count > 16)    // a Java class file also starts CAFEBABE; its "count" is a version
            return Architecture::unknown;

        const int entrySize = magicBE == 0xCAFEBABE ? 20 : 32;
        bool hasX64 = false, hasArm64 = false, has32 = false;

        for (juce::uint32 i = 0; i < count; ++i)
        {
            const auto offset = 8 + (juce::int64) i * entrySize;
            juce::uint8 entry[4] = {};
            if (offset + 4 <= got)
                std::memcpy (entry, head + offset, 4);
            else if (! in.setPosition (offset) || ! readExactly (in, entry, 4))
                return Architecture::unknown;

            switch (machCpuType (readBE32 (entry)))
            {
                case Architecture::x64:       hasX64 = true; break;
                case Architecture::arm64:     hasArm64 = true; break;
                case Architecture::bits32:    has32 = true; break;
                case Architecture::universal:            // machCpuType never says so
                case Architecture::unknown:   break;
            }
        }

        if (hasX64 && hasArm64) return Architecture::universal;
        if (hasArm64)           return Architecture::arm64;
        if (hasX64)             return Architecture::x64;
        if (has32)              return Architecture::bits32;
        return Architecture::unknown;
    }

    return Architecture::unknown;
}

/** Why a binary of `built` could not load into a host of `host`, as the token
    the page's `describeSkipReason` reads — or empty when the architecture is
    not the reason (it matches, or nothing confident can be said). */
inline juce::String whyUnloadable (Architecture built, Architecture host)
{
    if (built == Architecture::unknown || built == Architecture::universal || built == host)
        return {};
    if (built == Architecture::bits32)
        return "bits32";
    return "wrongArch";
}

/** Why a bundle holding these per-architecture binaries could not load into a
    host of `host`: one verdict for the lot. Silent when any of them could be
    the host's (it matches, is universal, or cannot be read) — then whatever
    stopped the plugin was not its architecture — "bits32" only when every one
    is 32-bit, and "wrongArch" otherwise. A bundle shipping x86-win beside
    x86_64-win is a 64-bit plugin that failed for some other reason, and
    reporting it from whichever folder happened to list first called it a
    32-bit one. */
inline juce::String whyUnloadable (const juce::Array<Architecture>& built, Architecture host)
{
    if (built.isEmpty())
        return {};

    bool all32 = true;
    for (const auto arch : built)
    {
        if (whyUnloadable (arch, host).isEmpty())
            return {};
        all32 = all32 && arch == Architecture::bits32;
    }
    return all32 ? "bits32" : "wrongArch";
}

/** The executables inside a plugin file or bundle: the file itself when it is
    one (.dll, .so, a single-file .vst3); otherwise the binary under
    `Contents/MacOS/` for a mac bundle, or one per architecture folder
    (`Contents/<arch>/<file>`) for a cross-platform VST3 bundle — every one of
    them, since a bundle may carry several and only all of them together say
    whether the architecture is the reason it did not load. Empty when nothing
    is found. */
inline juce::Array<juce::File> pluginBinariesOf (const juce::File& fileOrBundle)
{
    if (fileOrBundle.existsAsFile())
        return { fileOrBundle };

    juce::Array<juce::File> binaries;
    const auto contents = fileOrBundle.getChildFile ("Contents");
    if (! fileOrBundle.isDirectory() || ! contents.isDirectory())
        return binaries;

    const auto firstFileIn = [] (const juce::File& dir)
    {
        for (const auto& entry : juce::RangedDirectoryIterator (dir, false, "*", juce::File::findFiles))
            if (! entry.isHidden())
                return entry.getFile();
        return juce::File();
    };

    if (const auto macOS = contents.getChildFile ("MacOS"); macOS.isDirectory())
        if (const auto binary = firstFileIn (macOS); binary != juce::File())
            return { binary };

    for (const auto& dir : juce::RangedDirectoryIterator (contents, false, "*", juce::File::findDirectories))
    {
        if (dir.getFile().getFileName() == "Resources")
            continue;
        if (const auto binary = firstFileIn (dir.getFile()); binary != juce::File())
            binaries.add (binary);
    }

    return binaries;
}

/** The whole question for one plugin file the scan found and could not load:
    the reason token, or empty when nothing confident can be said. */
inline juce::String whyUnloadable (const juce::File& fileOrBundle)
{
    juce::Array<Architecture> built;

    for (const auto& binary : pluginBinariesOf (fileOrBundle))
    {
        juce::FileInputStream in (binary);
        // One binary that cannot be read is one that might be the host's.
        built.add (in.failedToOpen() ? Architecture::unknown : describeBinaryArchitecture (in));
    }

    return whyUnloadable (built, hostArchitecture());
}

} // namespace plectrify::pluginbinary
