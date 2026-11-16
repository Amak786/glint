import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the build works from any GitHub Pages sub-folder.
  base: './',
  plugins: [
    // Emulates a headset (with hands) in a desktop browser during `npm run dev`.
    iwsdkDev({ emulator: { device: 'metaQuest3' }, https: false }),
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5183, strictPort: true },
});
