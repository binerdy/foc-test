import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Netlify exposes the commit and deploy context as env vars at build time;
// bake them into the bundle so the footer can show which build is running.
const buildInfo = {
  commit: (process.env.COMMIT_REF ?? '').slice(0, 7) || 'dev',
  context: process.env.CONTEXT ?? 'local',
  builtAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
  },
})
