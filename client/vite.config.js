import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev: Vite serves the client on :5173 and proxies the Socket.IO websocket
// to the Node server on :3000, so the client always talks same-origin.
// Prod: the Node server serves client/dist itself — no proxy involved.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA: standalone fullscreen (no browser chrome mid-game), home-screen
    // install, and app-shell caching so reloads after iOS tab eviction or
    // Render cold starts paint instantly. `autoUpdate` is load-bearing:
    // phones must pick up new bundles on next launch, never serve stale.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['lampas-icon.svg', 'sounds/reveal.mp3'],
      manifest: {
        name: 'Lampas — Flashlight Hide & Seek',
        short_name: 'Lampas',
        description: 'Nighttime flashlight hide & seek, refereed by your phone',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/lampas-icon.png', sizes: '400x400', type: 'image/png' },
          { src: '/lampas-icon.png', sizes: '400x400', type: 'image/png', purpose: 'maskable' },
          { src: '/lampas-icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // Cache the app shell; NEVER intercept the live socket.
        navigateFallbackDenylist: [/^\/socket\.io/],
        runtimeCaching: [
          {
            // Map tiles: cache-first with a cap — huge win on park LTE.
            urlPattern: /^https:\/\/(tile\.openstreetmap\.org|[abc]\.tile\.opentopomap\.org|server\.arcgisonline\.com)\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 400, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // expose on LAN for phone testing
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
