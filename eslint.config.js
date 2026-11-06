import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'legacy/**',
      'node_modules/**',
      'samples/**',
      'public/**',
      'coverage/**',
      // Local audit output (screenshots, reports, one-off probes) – gitignored.
      'e2e-out/**',
      // Nested foreign clone sitting in this folder – not part of this project.
      'RowData-Converter/**',
      // Verbatim snapshots of earlier builds (e.g. the old service worker that
      // the cleanup test installs). They are evidence, not code we maintain.
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node ESM build scripts (sample generation, asset preparation).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // Browser globals: the e2e harness runs these snippets inside the page
        // via page.evaluate(), so they exist only in that context.
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        caches: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        performance: 'readonly',
        PerformanceObserver: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Rendering safety. This app displays hostile text taken from user files,
    // so every path from a file to the DOM must go through a text node. These
    // rules fail CI rather than warn (see README "Rendering safety").
    //
    // react/no-danger is expressed with no-restricted-syntax instead of a new
    // plugin: same effect, one fewer dependency to trust.
    files: ['src/**/*.{ts,tsx}', '**/*.mjs'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'never render file-derived text as HTML — render it as a text node (react/no-danger equivalent)',
        },
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'innerHTML parses HTML: use a text node (textContent) instead',
        },
        {
          selector: "AssignmentExpression[left.property.name='outerHTML']",
          message: 'outerHTML parses HTML: use a text node instead',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML parses HTML: build elements instead',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
          message: 'document.write parses HTML: never use it',
        },
        {
          selector: "JSXAttribute[name.name='srcDoc']",
          message: 'srcdoc embeds a document: never use it',
        },
        {
          selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='srcdoc']",
          message: 'srcdoc embeds a document: never use it',
        },
      ],
    },
  },
);
