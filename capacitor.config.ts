import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cybertv.player',
  appName: 'CyberIPTV',
  webDir: 'dist',
  backgroundColor: '#0b0b0d',
  android: {
    // IPTV providers are mostly plain HTTP; the page itself runs on http://localhost
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'http',
  },
};

export default config;
