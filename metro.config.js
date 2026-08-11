// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// This is a workaround for an issue with the `ws` library, a dependency of supabase-js.
// It tries to import the 'stream' module, which is not available in React Native.
// We configure Metro to use a browser-compatible version of 'stream'.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('stream-browserify'),
};

module.exports = config;