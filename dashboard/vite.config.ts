import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // Dev: the dashboard reads the live oracle-lite brain (activity timeline, stats, findings) same-origin
  // via this proxy, so the browser never hits CORS and prod can serve the built app behind the same host.
  server: {
    host: true, // bind 0.0.0.0 so a tunnel (cloudflared/ngrok) or the LAN can reach the dev server
    allowedHosts: true, // accept the tunnel's Host header (e.g. *.trycloudflare.com) instead of 403-ing it
    proxy: { "/api": "http://localhost:47778" },
  },
})
