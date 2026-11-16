// Плоска конфігурація ESLint 10: набір recommended плюс середовища за типом файла.
// Одноразові скрипти вимірювань (calc*, bench*) і мобільний клієнт не перевіряються
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'client/dist/**', 'mobile/**', 'results/**', 'calc*/**',
    'calc*.{js,mjs,cjs}', 'bench*', 'coverage/**', 'e2e-*.mjs'] },
  js.configs.recommended,
  { files: ['**/*.js', '**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
  { files: ['client/**/*.js', 'client/**/*.jsx'],
    languageOptions: { sourceType: 'module', globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } } } },
  { files: ['jest/**/*.js'], languageOptions: { globals: globals.jest } },
];
