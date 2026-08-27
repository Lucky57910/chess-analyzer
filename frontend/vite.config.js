import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// No dev proxy: there is no API to proxy to. The app talks to SQLite and to
// api.chess.com through Capacitor, both of which only exist on the device, so
// `npm run dev` is for laying out screens rather than running the app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
