/**
 * The Windows half of `host-plugin`: get a VST3 out of an upstream installer.
 *
 * THIS ONE GENUINELY INSTALLS SOFTWARE ON THIS MACHINE, which is why it is a
 * file of its own rather than a branch inside the shared flow. The installer is
 * run silently into a temporary directory, each VST3 it added or changed in the
 * shared VST3 folder is copied out, and the uninstaller is then run. Every
 * pre-existing bundle is backed up first and restored afterwards, so
 * Common Files\VST3 is left exactly as it was — including when the installer
 * overwrote something under the same name, which is why the snapshot
 * fingerprints content rather than trusting names.
 *
 * Nothing is uploaded if that cleanup does not complete: an incomplete restore
 * is a machine left in a state the author did not ask for, and it must be dealt
 * with before anything else happens.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Extraction, HostPluginContext, HostPluginPlatform } from './hostPlugin.ts';

export const windowsHost: HostPluginPlatform = {
  platform: 'windows-x64',

  options: {
    /** Where the VST3 lands when the installer runs. Overridable because not
     *  every installer uses the standard location. */
    vst3Dir: { type: 'string', default: 'C:\\Program Files\\Common Files\\VST3' },
  },

  requireHost: () => {
    if (process.platform !== 'win32') {
      throw fatal(
        'this runs the upstream Windows installer to get at its VST3, so it only works on Windows. The hosted archive it produces is pinned by hash in the catalogue, so it only needs running when the upstream version changes.',
      );
    }
  },

  extract,
};

function fatal(message: string): never {
  console.error(`\nhost-plugin: ${message}`);
  process.exit(1);
}

function powershell(script: string): { ok: boolean; output: string } {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function vst3Entries(dir: string): string[] {
  return (existsSync(dir) ? readdirSync(dir) : []).filter((name) =>
    name.toLowerCase().endsWith('.vst3'),
  );
}

/** Content fingerprint for a file or bundle directory. Timestamps are ignored:
 *  an installer touching an unchanged bundle is harmless, while any changed
 *  path or byte must make a same-name bundle eligible for collection. */
function fingerprint(root: string): string {
  const hash = createHash('sha256');

  const visit = (path: string, relative: string): void => {
    const info = lstatSync(path);

    if (info.isSymbolicLink()) {
      hash.update(`link\0${relative}\0${readlinkSync(path)}\0`);
      return;
    }

    if (info.isDirectory()) {
      hash.update(`dir\0${relative}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      return;
    }

    hash.update(`file\0${relative}\0${info.size}\0`);
    hash.update(readFileSync(path));
  };

  visit(root, '.');
  return hash.digest('hex');
}

/** Replace one explicit entry with a tree copy. Both callers use paths resolved
 *  from directory listings beneath either the temporary workspace or the
 *  caller-selected VST3 directory. */
function replaceEntry(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, force: true, preserveTimestamps: true });
}

async function extract(context: HostPluginContext): Promise<Extraction | null> {
  // Annotated, not inferred: TypeScript only narrows past a never-returning
  // call when the callee is a name with an explicit type.
  const fail: (message: string) => never = context.fail;

  const backupDir = join(context.work, 'pre-existing-vst3');
  if (existsSync(backupDir)) {
    fail(
      `a recovery backup from an earlier run still exists at ${backupDir}. Restore or remove it deliberately before running this script again; it will not be overwritten.`,
    );
  }

  const unpacked = join(context.work, 'unpacked');
  const expand = powershell(
    `Expand-Archive -LiteralPath '${context.payloadPath}' -DestinationPath '${unpacked}' -Force`,
  );
  if (!expand.ok) fail(`could not unpack the upstream asset.\n${expand.output}`);

  // --- Loose VST3? Then this plugin never needed hosting ---------------------
  const loose = powershell(
    `Get-ChildItem -LiteralPath '${unpacked}' -Recurse -Filter '*.vst3' | Select-Object -First 1 -ExpandProperty FullName`,
  );
  if (loose.ok && loose.output.trim()) {
    fail(
      `this release already contains a .vst3 (${loose.output.trim()}), so it does not need re-hosting. Point the catalogue's asset url straight at the upstream release instead — that keeps the project as its own distributor.`,
    );
  }

  const installer = powershell(
    `Get-ChildItem -LiteralPath '${unpacked}' -Recurse -Filter '*.exe' | Select-Object -First 1 -ExpandProperty FullName`,
  );
  if (!installer.ok || !installer.output.trim()) {
    fail('the upstream asset contains neither a .vst3 nor an installer executable.');
  }

  const installerPath = installer.output.trim();
  const appDir = join(context.work, 'app');

  if (context.dryRun) {
    console.log(`Would run: ${installerPath}`);
    return null;
  }

  // Snapshot first. Anything already in the shared VST3 folder is the user's and
  // must survive even when this installer overwrites it under the same name.
  const vst3Dir = resolve(context.options.vst3Dir as string);
  mkdirSync(backupDir, { recursive: true });

  interface ExistingBundle {
    name: string;
    backup: string;
    fingerprint: string;
  }

  // Names alone are insufficient: an installer may replace an older version at
  // the same path. Back up first, then fingerprint the live copy so that change
  // is both collectable and reversible.
  const before = new Map<string, ExistingBundle>();
  for (const name of vst3Entries(vst3Dir)) {
    const source = join(vst3Dir, name);
    const backup = join(backupDir, name);
    try {
      replaceEntry(source, backup);
      before.set(name.toLowerCase(), { name, backup, fingerprint: fingerprint(source) });
    } catch (error) {
      rmSync(backupDir, { recursive: true, force: true });
      fail(`could not back up the existing ${source} before installing.\n${errorMessage(error)}`);
    }
  }

  const uninstaller = join(appDir, 'unins000.exe');

  /** Undo the install's changes in the shared VST3 directory. The upstream
   *  uninstaller runs first; afterwards every entry that did not exist before is
   *  removed and every pre-existing entry is restored from our own backup. */
  function uninstallAndRestore(): string[] {
    const issues: string[] = [];

    if (!existsSync(uninstaller)) {
      issues.push(`no uninstaller appeared at ${uninstaller}`);
    } else {
      console.log('==> Uninstalling');
      const result = powershell(
        `$p = Start-Process '${uninstaller}' -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru; exit $p.ExitCode`,
      );
      if (!result.ok) issues.push(`the upstream uninstaller failed:\n${result.output}`);
    }

    // Even a missing or failed uninstaller must not leave its VST3 changes over
    // the top of the user's files. Limit cleanup to the .vst3 entries observed in
    // the explicit directory this script was asked to manage.
    let liveEntries: string[] = [];
    try {
      liveEntries = vst3Entries(vst3Dir);
    } catch (error) {
      issues.push(`could not inspect ${vst3Dir} during cleanup: ${errorMessage(error)}`);
    }

    for (const name of liveEntries) {
      if (before.has(name.toLowerCase())) continue;
      try {
        rmSync(join(vst3Dir, name), { recursive: true, force: true });
      } catch (error) {
        issues.push(`could not remove newly installed ${name}: ${errorMessage(error)}`);
      }
    }

    for (const snapshot of before.values()) {
      try {
        replaceEntry(snapshot.backup, join(vst3Dir, snapshot.name));
      } catch (error) {
        issues.push(
          `could not restore ${snapshot.name}: ${errorMessage(error)} (backup: ${snapshot.backup})`,
        );
      }
    }

    if (issues.length === 0) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch (error) {
        issues.push(`could not remove the completed recovery backup: ${errorMessage(error)}`);
      }
    }

    return issues;
  }

  function failAfterCleanup(message: string): never {
    const issues = uninstallAndRestore();
    fail(
      issues.length === 0
        ? message
        : `${message}\n\nThe installer cleanup was incomplete:\n  ${issues.join('\n  ')}\nRecovery backups remain at ${backupDir}.`,
    );
  }

  console.log(`==> Installing ${installerPath}`);
  const install = powershell(
    `$p = Start-Process '${installerPath}' -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/DIR="${appDir}"') -Wait -PassThru; exit $p.ExitCode`,
  );
  if (!install.ok) failAfterCleanup(`the installer failed.\n${install.output}`);

  const collected = (() => {
    try {
      return vst3Entries(vst3Dir).filter((name) => {
        const snapshot = before.get(name.toLowerCase());
        return !snapshot || fingerprint(join(vst3Dir, name)) !== snapshot.fingerprint;
      });
    } catch (error) {
      failAfterCleanup(`could not inspect what the installer changed.\n${errorMessage(error)}`);
    }
  })();

  if (collected.length === 0) {
    failAfterCleanup(
      `the installer added or changed no .vst3 in ${vst3Dir}. Pass --vst3Dir if it installs elsewhere.`,
    );
  }

  for (const name of collected) {
    try {
      replaceEntry(join(vst3Dir, name), join(context.staged, name));
    } catch (error) {
      failAfterCleanup(`could not copy ${name} out.\n${errorMessage(error)}`);
    }
  }

  const cleanupIssues = uninstallAndRestore();
  if (cleanupIssues.length > 0) {
    fail(
      `the VST3 was collected, but the installer cleanup was incomplete; nothing will be uploaded:\n  ${cleanupIssues.join('\n  ')}\nRecovery backups remain at ${backupDir}.`,
    );
  }

  return {
    collected,
    notes: [
      'HOW IT WAS EXTRACTED',
      '--------------------',
      'Upstream ships this plugin only as an installer executable. That installer',
      'was run silently into a temporary directory, each VST3 it added or changed',
      `in ${vst3Dir} was copied out, and the installer was then uninstalled.`,
      'Pre-existing bundles were backed up beforehand and restored afterwards; the',
      'extracted copies themselves were not modified or renamed.',
    ],
  };
}
