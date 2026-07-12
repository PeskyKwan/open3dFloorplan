// Static SPA: render entirely on the client so the build can be bundled into the
// native iOS app (Capacitor) and served from file://. No server needed.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'ignore';
