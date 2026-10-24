import type { CapacitorConfig } from '@capacitor/cli'

const isDev = process.env.NODE_ENV === 'development'

const config: CapacitorConfig = {
  appId: 'com.pocketengineer.coder',
  appName: 'Pocket Eng',
  // In dev, load from local Next.js server for hot-reload.
  // In production, load from the deployed Vercel URL.
  // No static export needed — the app requires a live backend anyway.
  ...(isDev
    ? {
        server: {
          url: 'http://localhost:3000',
          cleartext: true,
        },
      }
    : {
        server: {
          url: 'https://console.pocketeng.ai',
          // Keep OAuth flows inside the WKWebView instead of opening Safari
          allowNavigation: [
            'appleid.apple.com',
            '*.google.com',
            '*.github.com',
            'github.com',
            '*.supabase.co',
            '*.pocketeng.ai',
          ],
        },
      }),
  ios: {
    // Disable WKWebView zoom — prevents pinch-zoom getting stuck
    scrollEnabled: true,
    allowsLinkPreview: false,
    // Note: WKWebView's swipe-from-left-edge back gesture is enabled in
    // ios/App/App/CustomViewController.swift via a CAPBridgeViewController
    // subclass — Capacitor's config schema doesn't expose this option, so it
    // has to be set on the WKWebView directly in capacitorDidLoad().
  },
  android: {
    // Dark splash background to match the app theme
    backgroundColor: '#0a0a0f',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#0a0a0f',
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: 'dark',
    },
  },
}

export default config
