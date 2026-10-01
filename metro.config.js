// Expo's defaults, unchanged. The schema and the eleven analytics views are
// TypeScript template strings rather than .sql assets, so Metro needs no extra
// resolver and there is nothing here to get wrong.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
