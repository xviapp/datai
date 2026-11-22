const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: ['android/**', 'ios/**', '.expo/**', 'dist/**', 'public/**'],
  },
  expoConfig,
  {
    rules: {
      '@typescript-eslint/array-type': 'off',
    },
  },
]);
