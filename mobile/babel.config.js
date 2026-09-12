// SDK 50+: expo-router/babel is deprecated — babel-preset-expo covers it.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
