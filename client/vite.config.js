import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite serves the client on :5173 and proxies the Socket.IO websocket
// to the Node server on :3000, so the client always talks same-origin.
// Prod: the Node server serves client/dist itself — no proxy involved.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
