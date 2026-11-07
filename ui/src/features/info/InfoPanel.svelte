<script lang="ts">
  import { onDestroy, onMount, type Snippet } from 'svelte';
  import { ArrowSquareOutIcon } from 'phosphor-svelte';
  import type { AppInfo, StatusState } from '../../lib/engine/types';
  import {
    CHANGELOG_URL,
    DISCORD_URL,
    LATEST_RELEASE_URL,
    NOTICES_URL,
    REPO_URL,
    SITE_URL,
  } from '../../lib/links';
  import RowButton from '../../lib/components/RowButton.svelte';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import EngineStats from '../status/EngineStats.svelte';
  import { collectBrowserFacts, type BrowserFacts } from './browserFacts';
  import { formatDiagnostics, type DiagReport } from './diagnostics';
  import { buildBugReportUrl, buildIdeaUrl } from './issueReport';
  import { describeSystemUpdater, judgeUpdateChannel } from '../../lib/engine/updateChannel';
  import {
    describeUpdateInstallError,
    describeUpdateInstallPhase,
    isUpdateInstallBusy,
  } from '../../lib/engine/updateInstall';
  import { hasUpdate, parseVersion } from './updateCheck';
  import {
    checkForUpdate,
    latestVersion,
    updateChannel,
    updateInstall,
    updatePhase,
  } from './updateStore.svelte';

  interface Props {
    info: AppInfo;
    /** Builds the environment report (sections of label/value rows, see
        `diagnostics.ts`) from App's live state. A function rather than the
        report itself so the browser facts are measured exactly once, at
        mount — rebuilding them on every 15 Hz status push would re-measure
        the DOM with it. */
    getReport: (browser: BrowserFacts) => DiagReport;
    /** Live engine status for the CPU/RAM/latency readout. */
    status: StatusState;
    /** Hands the URL to the engine, which opens the default browser. */
    onOpenUrl: (url: string) => void;
    /** Re-asks the engine for its own facts. They change — audio device, plugin
        counts — and a push can be dropped while the window is occluded, so the
        panel asks again instead of reporting a device that is no longer open. */
    onRefresh: () => void;
    /** Whether the engine can install the update itself
        (HostCapabilities.selfUpdate — the Windows standalone). Then the row
        installs instead of opening the release page. */
    selfUpdate?: boolean;
    /** Starts the in-app install; progress arrives through the update store. */
    onInstallUpdate?: () => void;
    /** Whether the engine can open the desktop's updater
        (HostCapabilities.systemUpdates — the Linux standalone). Then the row
        follows the update channel: opens the updater once APT's index has
        the release, and the release page otherwise. */
    systemUpdates?: boolean;
    /** Opens the desktop's updates application. */
    onOpenSystemUpdater?: () => void;
    /** Asks the engine what APT's index knows now. Called on mount, because
        the boot-time probe is all the row would otherwise ever show: with
        the notice dismissed nothing else re-asks, and an `apt update` run by
        hand since would stay invisible. */
    onRequestUpdateChannel?: () => void;
  }

  let {
    info,
    getReport,
    status,
    onOpenUrl,
    onRefresh,
    selfUpdate = false,
    onInstallUpdate,
    systemUpdates = false,
    onOpenSystemUpdater,
    onRequestUpdateChannel,
  }: Props = $props();

  onMount(() => {
    onRefresh();
    if (systemUpdates && info.platform === 'linux') onRequestUpdateChannel?.();
  });

  // Shows whatever the start-up check already found, and runs one itself if
  // that has not landed yet or failed (offline at launch, online by now).
  onMount(() => {
    void checkForUpdate();
  });

  // Measured once at mount — panel open is the old dialog open. The rest of
  // the report stays live because getReport reads App's state.
  const browser = collectBrowserFacts();
  const report = $derived(getReport(browser));

  const versionLine = $derived(
    [info.version || '—', info.build ? `(${info.build})` : ''].filter(Boolean).join(' '),
  );

  const latest = $derived(latestVersion());
  const checking = $derived(updatePhase() === 'checking' || updatePhase() === 'idle');
  // Deliberately not gated on the user's dismissal: they asked, so they get the
  // answer even for a release they told the start-up notice to stop mentioning.
  const updateAvailable = $derived(updatePhase() === 'checked' && hasUpdate(info.version, latest));

  // The in-app install, where the engine offers it. While it runs the status
  // line follows it; a failure stays on the line beside the row to try again.
  const install = $derived(updateInstall());
  const installing = $derived(isUpdateInstallBusy(install));

  // The Linux channel (updateChannel.ts), read as the notice reads it: the
  // updater only once APT's index has the release — opened before that it
  // shows nothing to install — and the release page otherwise.
  const channel = $derived(updateChannel());
  const channelVerdict = $derived(judgeUpdateChannel(latest, channel));
  const systemUpdater = $derived(
    systemUpdates &&
      info.platform === 'linux' &&
      channel.updater !== '' &&
      channelVerdict === 'ready'
      ? describeSystemUpdater(channel.updater)
      : '',
  );

  const updateMessage = $derived.by(() => {
    if (installing) return describeUpdateInstallPhase(install);
    if (install.phase === 'failed') return describeUpdateInstallError(install.error);
    if (checking) return 'Checking for updates…';
    if (updatePhase() === 'failed') return "Couldn't reach GitHub. Check your connection.";
    if (updateAvailable) return `Plectrify ${latest} is available.`;
    // An unparseable version — the mock's 'dev', a hand-built binary — cannot
    // be compared, so it gets the fact rather than a reassurance we can't back.
    if (parseVersion(info.version) === null) return `Plectrify ${latest} is the newest release.`;
    return "You're up to date.";
  });

  const links = [
    { label: 'Website & docs', url: SITE_URL },
    { label: 'Project on GitHub', url: REPO_URL },
    { label: "What's new", url: CHANGELOG_URL },
    { label: 'Licence & third-party notices', url: NOTICES_URL },
  ];

  // The bug form's Diagnostics field is required, so on the rare report too long
  // to ride along in the URL the user has to paste it by hand. Put it on their
  // clipboard and say so — they are about to leave this panel for the browser,
  // and telling them afterwards to come back and find Copy is no help.
  let reportNote = $state('');
  let reportNoteTimer: ReturnType<typeof setTimeout> | undefined;

  async function reportBug() {
    const diagnostics = formatDiagnostics(report);
    const { url, overflowed } = buildBugReportUrl(diagnostics);
    if (overflowed) {
      clearTimeout(reportNoteTimer);
      try {
        await navigator.clipboard.writeText(diagnostics);
        reportNote =
          'Report too long to prefill — copied to your clipboard, paste it into the form.';
      } catch {
        reportNote = 'Report too long to prefill — copy the diagnostics above and paste them in.';
      }
      // Longer than the Copy button's 2s: the user is leaving for the browser
      // and reads this on the way back.
      reportNoteTimer = setTimeout(() => (reportNote = ''), 10000);
    }
    onOpenUrl(url);
  }

  // The clipboard can be refused (no permission, no secure context). The report
  // is on screen and selectable either way, so a refusal is recoverable by
  // hand — but it gets said out loud rather than passing for a copy.
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  const copyLabel = $derived(
    copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy',
  );

  async function copyDiagnostics() {
    clearTimeout(copyResetTimer);
    try {
      await navigator.clipboard.writeText(formatDiagnostics(report));
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
    copyResetTimer = setTimeout(() => (copyState = 'idle'), 2000);
  }

  onDestroy(() => {
    clearTimeout(copyResetTimer);
    clearTimeout(reportNoteTimer);
  });
</script>

<!-- Cards, not ruled sections — the same language as the settings and looper
     panels: one surface per group, the card's border doing the separating.
     Order follows what a player reaches for: which build am I on and is there
     a newer one, is the engine healthy, then the report and the ways of
     reaching someone, and last the links that only matter once something is
     wrong. -->
{#snippet cardHeader(title: string, action?: Snippet)}
  <div class="flex items-center justify-between gap-2 px-[.6rem] pt-[.35rem] pb-[.1rem]">
    <span class="text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase">{title}</span>
    {#if action}{@render action()}{/if}
  </div>
{/snippet}

{#snippet copyAction()}
  <Button size="sm" onclick={copyDiagnostics} tip="Copy the full report">
    {copyLabel}
  </Button>
{/snippet}

<div class="flex flex-col gap-2 px-[.6rem] pt-2 pb-[.6rem]">
  <!-- Identity and updates are one card: the version you have and the version
       there is are the same question asked twice. -->
  <Card>
    <div class="flex flex-col gap-[.15rem] px-[.6rem] pt-[.45rem] pb-2">
      <div class="flex items-baseline gap-2">
        <h2 class="text-sm font-semibold text-ink">Plectrify</h2>
        <p class="font-mono text-[11px] text-accent">{versionLine}</p>
      </div>
      <p class="text-xs leading-5 text-muted">A minimal standalone guitar-rig plugin host.</p>
    </div>
    <div class="flex items-center justify-between gap-3 px-[.6rem] pb-2">
      <p class="text-xs leading-5 text-muted" role="status" aria-live="polite">
        {updateMessage}
      </p>
      <Button size="sm" onclick={() => void checkForUpdate(true)} disabled={checking}>
        {checking ? 'Checking…' : 'Check now'}
      </Button>
    </div>
    {#if updateAvailable && selfUpdate && onInstallUpdate}
      <RowButton
        class="gap-2 rounded-none text-[.8rem]"
        onclick={onInstallUpdate}
        disabled={installing}
      >
        {installing ? `Installing ${latest}…` : `Install ${latest}`}
      </RowButton>
      {#if install.phase === 'failed'}
        <!-- The browser is the way forward whatever went wrong in here. -->
        <RowButton
          class="gap-2 rounded-none text-[.8rem]"
          onclick={() => onOpenUrl(LATEST_RELEASE_URL)}
        >
          Download {latest} in the browser
          <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
        </RowButton>
      {/if}
    {:else if updateAvailable && systemUpdater && onOpenSystemUpdater}
      <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={onOpenSystemUpdater}>
        Open {systemUpdater} to install {latest}
      </RowButton>
    {:else if updateAvailable}
      <RowButton
        class="gap-2 rounded-none text-[.8rem]"
        onclick={() => onOpenUrl(LATEST_RELEASE_URL)}
      >
        Download {latest}
        <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
      </RowButton>
    {/if}
  </Card>

  <Card>
    {@render cardHeader('Engine')}
    <div class="px-[.6rem] pb-2">
      <EngineStats {status} />
    </div>
  </Card>

  <Card>
    {@render cardHeader('Diagnostics', copyAction)}
    <span class="sr-only" role="status" aria-live="polite">
      {copyState === 'idle' ? '' : copyLabel}
    </span>
    <div id="about-diagnostics" class="max-h-36 overflow-y-auto px-[.6rem] pt-[.15rem] pb-2">
      {#each report.sections as section (section.title)}
        <section class="[&+&]:mt-[.7rem]">
          <h3 class="text-[.625rem] font-semibold tracking-[.14em] text-accent uppercase">
            {section.title}
          </h3>
          <dl
            class="mt-[.15rem] grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[.6875rem] leading-normal"
          >
            {#each section.rows as row (row.label)}
              <dt class="whitespace-nowrap text-muted/85">{row.label}</dt>
              <dd class="wrap-anywhere text-ink/80">{row.value}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </Card>

  <!-- Two entries rather than one "report a problem or idea": the bug form
       carries the diagnostics and demands steps to reproduce, neither of
       which an idea needs. Sending both through one form is how a required
       field turns into something people paste past. -->
  <Card>
    {@render cardHeader('Feedback')}
    <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={reportBug}>
      Report a bug
      <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
    </RowButton>
    <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={() => onOpenUrl(buildIdeaUrl())}>
      Suggest an idea
      <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
    </RowButton>
  </Card>

  {#if reportNote}
    <p class="px-[.6rem] text-xs leading-5 text-muted" role="status" aria-live="polite">
      {reportNote}
    </p>
  {/if}

  <!-- Its own card rather than a fourth About row: About is where the licence
       and the changelog live, which is not where anyone looks for people. -->
  <Card>
    {@render cardHeader('Community')}
    <p class="px-[.6rem] pb-[.35rem] text-xs leading-5 text-muted">
      Ask questions, share rigs, hear about releases.
    </p>
    <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={() => onOpenUrl(DISCORD_URL)}>
      Join the Discord
      <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
    </RowButton>
  </Card>

  <Card>
    {@render cardHeader('About')}
    {#each links as link (link.url)}
      <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={() => onOpenUrl(link.url)}>
        {link.label}
        <ArrowSquareOutIcon size={12} class="ml-auto opacity-55" />
      </RowButton>
    {/each}
  </Card>

  <p class="px-[.6rem] pt-[.15rem] text-[11px] text-muted/80">
    © 2026 Plectrify contributors · AGPLv3 · No warranty · Built with JUCE
  </p>
</div>
