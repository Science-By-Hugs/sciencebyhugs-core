import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.VITE_BASE_PATH || '/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        importScripts: ['push-sw.js'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
      },
      includeAssets: [
        'brand/core.svg',
        'brand/core-app-icon.svg',
        'brand/core-icon-192.png',
        'brand/core-icon-512.png',
        'brand/core-apple-touch-icon.png',
      ],
      manifest: {
        id: '/',
        name: 'core. — Science By Hugs',
        short_name: 'core',
        description: 'Internal operations for Science By Hugs.',
        theme_color: '#171A1C',
        background_color: '#171A1C',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        icons: [
          {
            src: `${base}brand/core-icon-192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: `${base}brand/core-icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: `${base}brand/core-icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ]
})
