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
  import { hasUpdate, parseVersion } from './updateCheck';
  import { checkForUpdate, latestVersion, updatePhase } from './updateStore.svelte';

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
  }

  let { info, getReport, status, onOpenUrl, onRefresh }: Props = $props();

  onMount(() => onRefresh());

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

  const updateMessage = $derived.by(() => {
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
      <p class="text-xs leading-5 text-muted">A minimal standalone guitar-rig VST3 host.</p>
    </div>
    <div class="flex items-center justify-between gap-3 px-[.6rem] pb-2">
      <p class="text-xs leading-5 text-muted" role="status" aria-live="polite">
        {updateMessage}
      </p>
      <Button size="sm" onclick={() => void checkForUpdate(true)} disabled={checking}>
        {checking ? 'Checking…' : 'Check now'}
      </Button>
    </div>
    {#if updateAvailable}
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
