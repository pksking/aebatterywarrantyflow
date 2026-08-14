module.exports = {
  expo: {
    name: 'AE Complaint Logs',
    slug: 'ae-complaint-logs',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    updates: {
      url: 'https://u.expo.dev/a2b99b19-d291-4461-b0b3-39cd38f2a7d3',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    extra: {
      eas: {
        projectId: 'a887383c-9ded-4145-b918-9d577b5ecfbf',
      },
    },
    android: {
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      package: 'com.aecomplaintlogs.app',
      permissions: [
        'CAMERA',
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ],
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.aecomplaintlogs.app',
      infoPlist: {
        NSCameraUsageDescription: 'WarrantyFlow uses your camera to scan product QR codes and serial labels.',
      },
    },
    plugins: [
      [
        'expo-build-properties',
        {
          android: {
            gradleVersion: '8.4',
          },
        },
      ],
    ],
  },
};