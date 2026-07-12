import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Static SPA build so the web editor can be bundled into the native iOS app
		// (Capacitor) and future desktop shells. All routes fall back to the SPA shell.
		adapter: adapter({
			fallback: 'index.html',
			strict: false
		})
	}
};

export default config;
