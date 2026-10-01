/**
 * Nothing but the Expo preset.
 *
 * The web app's ring animation was a CSS keyframe; here it is React Native's
 * built-in Animated API, which needs no Babel plugin. Reanimated would have
 * needed one, in a position-sensitive slot, in a build nobody can run — so it
 * is deliberately absent. If you ever add it, its plugin must be listed last.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
