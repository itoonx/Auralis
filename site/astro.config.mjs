import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// LAUNCH GATE (docs: landing plan §6): set the real custom domain before the
// first deploy — canonical/OG/sitemap URLs all derive from `site`.
const site = process.env.SITE_URL ?? 'https://auralis.example'

export default defineConfig({
  site,
  output: 'static',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
})
