import { defineConfig, loadEnv } from 'vite'
import { validateV2Environment } from './src/environment'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.VITE_BASE_PATH || '/'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  for (const name of Object.keys(env)) {
    if (/SECRET|PASSWORD|SERVICE_ROLE|TOKEN|PRIVATE_KEY/.test(name)) throw new Error('Secret-like VITE variable is forbidden: ' + name)
  }
  validateV2Environment({
    appEnv: env.VITE_APP_ENV, supabaseUrl: env.VITE_SUPABASE_URL,
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY, expectedProjectRef: env.VITE_EXPECTED_SUPABASE_REF,
    appOrigin: env.VITE_APP_ORIGIN, paymentEnv: env.VITE_PAYMENT_ENV,
    enableTestPayments: env.VITE_ENABLE_TEST_PAYMENTS,
  })
  return {
  server: { port: 5174, strictPort: true },
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
        name: 'CORE 2.0 — Internal Staging',
        short_name: 'CORE Test',
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
  }
})
