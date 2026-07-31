// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        sourcemap: 'inline',
        target: 'esnext',
        minify: false
    },
    server: {
        port: 8080,
        host: true,
        allowedHosts: ['169.254.0.42', 'hal.yeet.fm', 'dex.sgc.ai', 'localhost', '127.0.0.1'],
        proxy: {
            // Strip /aiproxy/ prefix to match server.js routes (mirrors nginx prod config).
            '/aiproxy': {
                target: 'http://127.0.0.1:7070',
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/aiproxy/, '')
            },
            // start_servers.js mounts each sub-server at /<name>; keep the prefix.
            '^/(check|webscrape|recall|wikisearch|wolframalpha|directaccess|automation)': {
                target: 'http://127.0.0.1:7071',
                changeOrigin: true
            }
        }
    },
    worker: {
        format: 'es'
    }
});