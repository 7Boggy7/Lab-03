import { defineConfig } from 'vite';
import { mockApi } from './server/mock-api.js';

export default defineConfig({
  root: '.',
  plugins: [mockApi()],
  build: {
    outDir: 'dist',
  },
});
