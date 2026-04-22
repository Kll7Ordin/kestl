import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const host = process.env.TAURI_DEV_HOST;
const tauriConf = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf-8'));
const APP_VERSION: string = tauriConf.version;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  clearScreen: false,
  server: {
    host: host || '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
