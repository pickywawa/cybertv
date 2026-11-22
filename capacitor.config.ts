import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cybertv.player',
  appName: 'CyberIPTV',
  webDir: 'dist',
  backgroundColor: '#0b0b0d',
  android: {
    // IPTV providers are mostly plain HTTP; the page itself runs on http://localhost
    allowMixedContent: true,
    // CYBER_INSPECT=1: release build whose WebView can be inspected (on-device debugging, never published)
    webContentsDebuggingEnabled: process.env.CYBER_INSPECT === '1',
  },
  server: {
    androidScheme: 'http',
  },
};

export default config;
