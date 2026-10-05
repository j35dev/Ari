import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * The mobile client is a static bundle with no server of its own.
 *
 * In the managed layout it is uploaded to Cloudflare static assets; under
 * Tailscale the desktop gateway serves it from this same build, which is what
 * makes the PWA same-origin with the API it calls. Nothing here may depend on
 * a dev server being present at runtime.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The gateway serves these files; hashed names let it cache them forever.
    assetsDir: 'assets',
  },
  server: {
    port: 5273,
  },
})
