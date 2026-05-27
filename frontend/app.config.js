require('dotenv').config();

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

if (!GOOGLE_MAPS_KEY && process.env.EAS_BUILD === 'true') {
  throw new Error('❌ FATAL: GOOGLE_MAPS_API_KEY is required for EAS Build!');
}

module.exports = {
  expo: {
    name: 'Se-Q',
    slug: 'se-q',
    version: '2.1.9',
    owner: 'ae1982',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'safeguard',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: {
      image: './assets/images/splash-image.png',
      resizeMode: 'contain',
      backgroundColor: '#0F172A',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.seq.app',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        backgroundColor: '#0F172A',
      },
      package: 'com.seq.app',
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'CAMERA',
        'RECORD_AUDIO',
        'SEND_SMS',
        'READ_PHONE_STATE',
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
        'WAKE_LOCK',
        'FOREGROUND_SERVICE',
        'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      ],
    },
    extra: {
      eas: {
        projectId: '20b077ed-ef31-4522-8f6e-be1dbd9eaa73',
      },
      backendUrl: 'https://se-q-production.up.railway.app',
      googleMapsApiKey: GOOGLE_MAPS_KEY,
    },
    // No plugins needed — Google Maps JS API is loaded in the WebView HTML,
    // no native Android/iOS SDK to link.
  },
};
