// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// This is a workaround for an issue with libraries like `supabase-js` that use Node.js core modules.
// We configure Metro to use browser-compatible versions (polyfills) for these modules.
const nodeCoreModules = {
  assert: require.resolve('assert'),
  buffer: require.resolve('buffer'),
  crypto: require.resolve('crypto-browserify'),
  events: require.resolve('events'),
  fs: require.resolve('react-native-level-fs'),
  http: require.resolve('http-browserify'),
  https: require.resolve('https-browserify'),
  net: require.resolve('net-browserify'),
  path: require.resolve('path-browserify'),
  querystring: require.resolve('querystring-es3'),
  stream: require.resolve('stream-browserify'),
  tls: require.resolve('tls-browserify'),
  url: require.resolve('url'),
  util: require.resolve('util'),
  zlib: require.resolve('browserify-zlib'),
};

config.resolver.extraNodeModules = { ...config.resolver.extraNodeModules, ...nodeCoreModules };

module.exports = config;