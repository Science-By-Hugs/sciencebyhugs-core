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
        name: 'CORE — Science By Hugs',
        short_name: 'CORE',
        description: 'CORE — Control. Operate. Manage. Internal operations system for Science By Hugs.',
        theme_color: '#0A0A0B',
        background_color: '#0A0A0B',
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
