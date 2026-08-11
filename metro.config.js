// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// This is a workaround for an issue with the `ws` library, a dependency of supabase-js.
// It tries to import Node.js core modules, which are not available in React Native.
// We configure Metro to use browser-compatible versions of these modules.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('stream-browserify'),
  zlib: require.resolve('browserify-zlib'),
  crypto: require.resolve('crypto-browserify'),
  util: require.resolve('util'),
  events: require.resolve('events'),
  http: require.resolve('http-browserify'),
  https: require.resolve('https-browserify'),
  net: require.resolve('net-browserify'),
  tls: require.resolve('tls-browserify'),
  buffer: require.resolve('buffer'),
  url: require.resolve('url'),
  assert: require.resolve('assert'),
};

module.exports = config;