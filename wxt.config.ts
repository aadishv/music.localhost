import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'peak ytm',
    description: 'makes ytm more peak',
    version: '1.0.0',
    permissions: ['tabs', 'activeTab'],
    host_permissions: ['ws://127.0.0.1:32145/*'],
    action: {},
  },
  webExt: {
    disabled: true,
  }
});


