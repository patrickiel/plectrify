/** Whether the page is rendering on macOS, for wording alone — "Reveal in
    Finder" vs "in Explorer", nothing more. Read from the renderer rather than
    the engine because the words describe the OS the window is literally on,
    which is true even in a plain-browser mock session. Anything that changes
    *behaviour* must come from the engine instead (AppInfo.platform, or facts
    the engine computes itself, like a catalogue row's availability). */
export const isMac = /mac/i.test(navigator.platform);
