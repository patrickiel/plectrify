# Handoff: issue #40 — Windows crash after full Rescan (PR #42)

Written 2026-11-09 on Linux, for continuing on Windows. Untracked file in the
repo root; delete it once the PR is merged.

- Issue: https://github.com/patrickiel/plectrify/issues/40
- PR: https://github.com/patrickiel/plectrify/pull/42
- Branch: `issue-40-out-of-process-plugin-scan`, three commits on top of main:
  - `ca93878 fix: scan plugins in a worker process so a crashing plugin cannot take the app down`
  - `fa9a121 docs: add handoff note for the Windows test of the scan worker` (this file)
  - `dd207e3 fix: hand scan replies over by swap, not move, and end the worker before its members go`
    (the Linux crash below; also adds the probe)
- Reporter's files: `~/Downloads/Plectrify/` on the Linux box
  (`plectrify.log`, `known_plugins.xml`, `Plectrify-20261105-231357.dmp`)

## What the evidence showed

- Every Rescan launch on Nov 6 and 7 in the reporter's log ends right after
  the last two legacy `.dll`s in scan order loaded: `WaveShell-VST 9.91_x64.dll`
  then `iZVocalDoubler.dll`. No clean-shutdown line, no CRASH line, no dump.
- Several launches died *during* a load (`Creating VST instance: JCM800 (Hot)
  Preamp v1.3`, Mercuriall). Our `SetUnhandledExceptionFilter` handler never
  saw those either. Conclusion: in-process VST2-era loads leave code running
  after `FreeLibrary` (threads, timers, window procs) and some plugins replace
  the process-wide exception filter, so the handler cannot be trusted while
  third-party code runs in-process.
- The only 0.1.8 dump (Nov 5) is unrelated: access violation at
  `0x7ffee20efcb9` inside `igd10iumd64.dll` (Intel graphics driver), normal use.
- Blacklist already in the reporter's `known_plugins.xml`: Kontakt 7.vst3,
  LG2AmpV0030.vst3, DS-10 Drum Shaper (.vst3 and .dll).
- 0.1.8 PDB: `windows` artifact of Release run 41917129089 (128 MB, never
  downloaded).

Pre-agreed decision (memory): out-of-process scanning. Do **not** propose the
"keep DLLs loaded" workaround.

## What the PR does

The standalone no longer loads plugins while scanning. Each file goes to a
worker process: the same exe relaunched with `--plectrify-scan-worker:<pipe>`
through JUCE's `ChildProcessCoordinator` / `ChildProcessWorker` (the
AudioPluginHost arrangement). The worker loads the file and replies with the
`PluginDescription`s as XML.

Files:

- `Source/plugins/PluginScanWorker.h/.cpp` (new): protocol, `PluginScanWorker`
  (worker side), `OutOfProcessPluginScanner` (app side,
  `KnownPluginList::CustomScanner`).
- `Source/plugins/PluginManager.h/.cpp`: `setScanWorkerExecutable(File)`;
  dead-man's-pedal file only for in-process scans; saves when blacklist count
  changes.
- `Source/app/HostServices.h`: `virtual File pluginScanWorkerExecutable()`
  (default empty = in-process). `MainComponent.h` returns its own exe.
  `PlectrifyEngine.cpp` ctor feeds it to the PluginManager before
  `scanBundledPluginsIfNeeded()`.
- `Source/app/Main.cpp`: worker mode. `moreThanOneInstanceAllowed()` true for
  the worker; `initialise()` builds a `PluginScanWorker` instead of the window;
  own logger `plectrify-scan.log` beside `plectrify.log`; no crash handler.
- `CMakeLists.txt` + `scripts/shared.ts` (`TEST_TARGETS`): new CTest
  `Plectrify.PluginScanWorker` (`Tests/plugins/PluginScanWorkerTests.cpp`,
  pure codec/command-line tests).
- `AGENTS.md`: PluginManager section documents the rules; VST3 build still
  scans in-process (no exe of ours inside a DAW).
- `ui/src/features/rack/BlacklistDialog.svelte`: wording for "Skipped plugins".

Attribution rules in `OutOfProcessPluginScanner::findPluginTypesFor`:

| Worker outcome | Action |
| --- | --- |
| replied (`found`) | descriptions appended, return true |
| bad reply | logged, return true (not blamed) |
| could not send (worker already dead before request) | previous file's leftovers killed it: relaunch, no blame, retry |
| died after request sent | log "died loading X; skipped from now on", return false (= blacklisted) |
| silent for 90 s (`fileTimeoutMs`) | kill worker, return false (blacklisted) |
| scan abandoned | kill worker, return true |
| launch failure, or two fresh workers dying before answering anything | `inProcessFallback` for the rest of the scan, logged |

Timeouts: `fileTimeoutMs = 90'000`, worker ping `connectionTimeoutMs = 120'000`
(must exceed fileTimeoutMs), coordinator `launchTimeoutMs = 10'000`.
Worker on connection lost: 5 s watchdog thread → `TerminateProcess`, then
`JUCEApplicationBase::quit()`. On Windows the worker sets
`SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX)`
and a top-level filter that logs one CRASH line and returns
`EXCEPTION_EXECUTE_HANDLER` (no WER UI, no dump).

## Crash found on Linux after the first push (fixed in `dd207e3`)

A reset + starter-bundle install on Linux crashed the app at the end of the
scan: SIGSEGV on the IPC read thread in
`OutOfProcessPluginScanner::Worker::handleMessageFromWorker`, `reply = mb`.
Cause: `waitFor` handed the reply out with `std::move`, and JUCE's
`MemoryBlock` move constructor takes the buffer but **leaves the old size**
behind, so the moved-from `reply` read as N bytes at a null pointer. The next
reply of exactly N bytes made `setSize` a no-op and `memcpy` wrote to null.
Two consecutive plugin descriptions of equal length (Lupex Delay → peakeater)
was all it took, hence intermittent. Fixed with `swapWith` instead of a move.
A second, latent bug fixed alongside: `~Worker` now calls `killWorkerProcess()`
in its own body, before its mutex and reply block are destroyed.

Reproduced and verified with the new manual probe (not a CTest):

```
PlectrifyScanWorkerProbe <Plectrify exe> <rounds> <plugin files...>
# Linux: build-linux-debug/PlectrifyScanWorkerProbe_artefacts/Debug/PlectrifyScanWorkerProbe \
#          build-linux-debug/Plectrify_artefacts/Debug/Plectrify 30 ~/.vst3/*.vst3
# Windows: build\PlectrifyScanWorkerProbe_artefacts\Debug\PlectrifyScanWorkerProbe.exe ^
#          build\Plectrify_artefacts\Debug\Plectrify.exe 30 "C:\Program Files\Common Files\VST3\*.vst3" <.dll files...>
```

Before the fix it crashed in round 1; after it, 30 rounds over 13 files agreed
(~100 ms per round), no leftover worker processes. Run it on Windows too; the
wildcard needs expanding by hand or in PowerShell (`(Get-ChildItem ...).FullName`).

## Verified on Linux (re-run after `dd207e3`)

- `pnpm app --dist --no-run`: UI format/check OK, 761 vitest tests pass,
  native app builds, CTest 15/15 (incl. new `Plectrify.PluginScanWorker`).
- `PlectrifyPlugin_VST3` target links. Root `pnpm check` OK.
- Known harmless: a `juce_String.cpp:327` assertion in the test binary comes
  from JUCE's own static initialiser (`RelativeCoordinate::Strings::parent`),
  traced with gdb; not ours.

## To do on Windows (the reporter's platform, not exercised yet)

1. `git fetch && git checkout issue-40-out-of-process-plugin-scan`, then
   `pnpm app` (Debug). MSVC may find warnings/errors GCC did not: check
   `PluginScanWorker.cpp` compiles (Windows-only block around `SetErrorMode` /
   `SetUnhandledExceptionFilter` / `TerminateProcess`).
2. Full Rescan from the UI. Expect:
   - a second `Plectrify.exe` in Task Manager during the scan, gone afterwards
   - `%APPDATA%\Plectrify\plectrify-scan.log` written ("Plectrify <v> scan
     worker starting", one "Scanning <file>" line per file, "scan worker exiting")
   - `plectrify.log` shows no "Attempting to load VST" lines from the app
     process itself (those now come from the worker)
   - a crashing plugin lands in Settings → Skipped plugins instead of closing
     the app; app survives the seconds after "Scan complete"
3. Check `Plectrify.PluginScanWorker` passes in CTest on MSVC
   (`pnpm app --dist --no-run`).
4. Sanity: legacy `.dll`s that load fine still appear in the drawer with the
   extension chip; a VST3 shell (Waves WaveShell) still lists its members.
5. Edge cases worth a look: worker launch while the app is a Release install
   (exe path from `File::currentExecutableFile`); the reset relaunch
   (`--plectrify-after-reset`) still not mistaken for a worker (tested in codec
   tests only).
6. If all good: merge PR #42 (user's call, never auto-merge), delete this file.

If the Windows test fails, first look at `plectrify-scan.log`'s last
"Scanning …" line (names the file a dead worker was loading) and at the
attribution rules above.

## Verified on Windows (2026-11-09)

- `pnpm app --dist --no-run`: MSVC builds with no new warnings, CTest 15/15.
- Probe, Debug exe, 30 rounds over the 9 real VST3s here (inner `.vst3`
  paths — pass those, not the bundle folders, or the probe counts 0 for
  bundles): all found every round, ~300 ms/round, no leftover processes.
- Failure paths, with synthetic plugins compiled from a few lines of C++
  (`GetPluginFactory` that faults / `Sleep(INFINITE)` / returns null and
  leaves a thread that faults 1.5 s later; a `.dll` whose `VSTPluginMain`
  returns null): crash → CRASH line in `plectrify-scan.log`, blacklisted;
  hang → killed at 90.0 s, blacklisted; lingerer and the legacy fakes →
  answered, not blamed. App-level: with the cache removed and the fakes in
  `third_party/plugins`, the startup scan blacklisted the crasher, kept NAM,
  and the app stayed up.
- **Found and fixed** (commit after `704f7fe`): on Windows a dead worker
  was noticed only after 20 s — the app owns the named pipe and JUCE's
  server end waits for a new client on a broken pipe instead of reporting
  it, so only the 10 s ping timeout spoke, and the kill message in
  `killWorkerProcess` then waited another 10 s. The worker now sends its
  pid as a hello, the app polls a process handle while waiting, and a dead
  worker is torn down on its own thread. Crash cost: 20 s → ~0.6 s.
- Not done here: a Rescan clicked in the UI (no real legacy `.dll` is
  installed on this machine either), and the Release-install exe path.
  Both are a minute of hand-testing for the reporter's setup.

## Memory

`~/.claude/projects/-home-patrick-dev-plectrify/memory/rescan-crash-0-1-8.md`
holds the same findings for future sessions on this machine. The Windows
machine has its own memory dir, so this file is the carrier.
