/**
 * Download the currently rendered app as a portable, style-complete HTML
 * snapshot. This intentionally exports the DOM rather than a panel registry:
 * any new view is exportable automatically, including transient stage views.
 */
export async function exportCurrentView(): Promise<void> {
  const documentClone = document.documentElement.cloneNode(true) as HTMLElement;
  documentClone.querySelectorAll('[data-export-view]').forEach((node) => node.remove());
  documentClone.querySelectorAll('script').forEach((node) => node.remove());

  const styles = documentClone.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  for (const link of styles) {
    try {
      const response = await fetch(link.href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const style = document.createElement('style');
      style.textContent = await inlineCssAssets(await response.text());
      link.replaceWith(style);
    } catch {
      // Keep an inaccessible stylesheet as a link rather than making export
      // fail because a browser extension or a remote stylesheet disappeared.
    }
  }

  const html = `<!doctype html>\n${documentClone.outerHTML}`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `plectrify-view-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function inlineCssAssets(css: string): Promise<string> {
  const urls = [...css.matchAll(/url\((['"]?)([^'"\)]+)\1\)/g)].map((match) => match[2]);
  const replacements = await Promise.all(
    [...new Set(urls)]
      .filter((url) => !/^(?:data|blob|https?):/i.test(url))
      .map(async (url) => {
        try {
          const response = await fetch(new URL(url, window.location.href));
          if (!response.ok) return [url, url] as const;
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const mime = response.headers.get('content-type') ?? 'application/octet-stream';
          return [url, `data:${mime};base64,${btoa(binary)}`] as const;
        } catch {
          return [url, url] as const;
        }
      }),
  );
  return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), css);
}
