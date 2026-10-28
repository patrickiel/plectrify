/** Which desktop the page is rendering on, for wording alone — "Reveal in
    Finder" vs "in Explorer" vs "in your file manager", nothing more. Read from the renderer rather than
    the engine because the words describe the OS the window is literally on,
    which is true even in a plain-browser mock session. Anything that changes
    *behaviour* must come from the engine instead (AppInfo.platform, or facts
    the engine computes itself, like a catalogue row's availability). */
export const isMac = /mac/i.test(navigator.platform);
export const isLinux = /linux/i.test(navigator.platform);

/** What the OS calls the app that shows a folder. Linux has no one answer. */
export const fileManagerName = isMac ? 'Finder' : isLinux ? 'your file manager' : 'Explorer';
