/**
 * Where Plectrify's Vite dev server lives — one declaration, read by the run
 * scripts, by the OS-specific helpers that name whoever holds the port, and by
 * `ui/vite.config.ts` itself, so the server and the app looking for it cannot
 * disagree.
 *
 * Deliberately **not** Vite's default 5173. That port is a shared resource:
 * every Vite project on the machine wants it, so the first dev server started
 * that day owns it and Plectrify's own is pushed to 5174 — where nothing looks
 * for it — or, worse, the app loads whatever UI that other project is serving.
 * The run scripts can detect this (`devServerStatus` checks for a Plectrify
 * sentinel in the served index) but can only refuse and ask for the other
 * server to be stopped, which is a collision reported, not prevented. A port of
 * our own is the prevention; `site/` keeps the default, so the two halves of
 * this repo no longer fight over one port either.
 *
 * `strictPort` in the Vite config is the other half: if something does hold
 * this port, Vite must fail loudly rather than drift to the next one and leave
 * the app pointed at nothing.
 */
export const DEV_SERVER_PORT = 5273;

/** The dev server's origin — what `PLECTRIFY_DEV_URL` is set to. */
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
