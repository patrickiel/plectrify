/**
 * `pnpm app` — one dev-loop command on every OS. Dispatches to the platform
 * implementation (run.windows.ts / run.macos.ts), which share their modes:
 * no flag for the HMR loop, --ui-only, --dist, --no-ui, --no-run, --clean,
 * --plugin (build + install the Debug VST3 for a DAW to host instead of
 * launching the app), --config <Debug|Release>. The release pipelines dispatch
 * the same way, from release.ts — see the note there on why announcing the
 * step, rather than making you name it, is what keeps a two-machine release
 * legible.
 */
if (process.platform === 'win32') {
  await import('./run.windows.ts');
} else if (process.platform === 'darwin') {
  await import('./run.macos.ts');
} else {
  console.error('error: Plectrify builds on Windows and macOS only.');
  process.exit(1);
}
