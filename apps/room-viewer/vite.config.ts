import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * polish M6: Rapier's compat build inlines its 2 MB WebAssembly as base64 inside rapier.mjs, which made a
 * 2.85 MB chunk (the only one over the 500 kB warning; it was already lazy-loaded). The package ships the
 * identical binary beside it (rapier_wasm3d_bg.wasm, byte-for-byte equal in 0.20.0), so the build swaps
 * the base64 literal for an asset URL; wasm-bindgen's init accepts a URL and streams it. Dev is untouched.
 * If a Rapier upgrade changes the layout, the build fails here instead of silently shipping the blob.
 */
function rapierWasmAsset(): Plugin {
  return {
    name: 'rapier-wasm-asset',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/@dimforge[\\/]rapier3d-compat[\\/]dist[\\/]rapier\.mjs$/.test(id)) return;
      const out = code.replace(/\b\w+\.toByteArray\("AGFzbQ[A-Za-z0-9+/=]+"\)\.buffer/, 'new URL("./rapier_wasm3d_bg.wasm", import.meta.url)');
      if (out === code) this.error('rapier-wasm-asset: inlined wasm not found in rapier.mjs');
      return { code: out, map: null };
    },
  };
}

const app = import.meta.dirname;
const repository = resolve(app, '../..');

export default defineConfig({
  root: app,
  plugins: [rapierWasmAsset()],
  base: process.env.VIEWER_BASE || '/',
  optimizeDeps: { include: ['three/addons/objects/Reflector.js'] },
  publicDir: resolve(repository, 'data/web-assets'),
  server: {
    host: '127.0.0.1', port: 5188, strictPort: true, fs: { allow: [repository] },
    // Render evidence is output, not application source. Publishing a preview
    // image must not reload every viewer/capture in the middle of a build.
    watch: { ignored: ['**/data/captures/**', '**/data/recordings/**', '**/data/web-assets/office-v4/live/**'] },
  },
  build: {
    outDir: resolve(app, 'dist'),
    rolldownOptions: {
      input: {
        main: resolve(app, 'index.html'),
        play: resolve(app, 'play.html'),
        capture: resolve(app, 'tools/capture.html'),
      },
    },
  },
});
