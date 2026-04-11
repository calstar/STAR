import { defineConfig } from 'vitest/config';
// @ts-ignore: Next.js strictly follows TS config for moduleResolution, but vitest plugins provide nodenext exports
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        setupFiles: ['./vitest.setup.ts'],
        globals: true,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './'),
        },
    },
});
