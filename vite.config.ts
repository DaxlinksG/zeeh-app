import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Capacitor loads the web app from the device filesystem via a custom scheme.
  // Relative paths are required so assets resolve correctly inside the WebView.
  base: './',
})
