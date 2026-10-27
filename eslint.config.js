import tseslint from 'typescript-eslint';
import checkFile from 'eslint-plugin-check-file';
import sonarjs from 'eslint-plugin-sonarjs';
import prettierConfig from 'eslint-config-prettier';

const sonarjs_code_smell_rules = {
  'sonarjs/cognitive-complexity': ['error', 15],
  'sonarjs/no-identical-functions': 'error',
  'sonarjs/no-duplicated-branches': 'error',
  'sonarjs/no-all-duplicated-branches': 'error',
  'sonarjs/no-identical-expressions': 'error',
  'sonarjs/no-redundant-jump': 'error',
  'sonarjs/no-unused-collection': 'error',
};

/**
 * Type-aware rules. The promise and throw rules are clean today and only guard against regressions.
 * The no-unsafe-* rules catch values that arrive untyped from JSON.parse and the Microsoft Graph
 * client. Adapters convert those responses to declared shapes before the values reach services.
 */
const type_aware_rules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
};

/**
 * Structural conventions from `.claude/CLAUDE.md` that nothing checked before.
 * Folder naming is an error because the tree is already clean. The
 * relative-import and function-length rules are warnings until their existing
 * hits are fixed, then they are promoted to errors too.
 */
const structural_convention_rules = {
  'no-restricted-imports': [
    'warn',
    {
      patterns: [
        {
          group: ['./*', '../*'],
          message: 'Use the @/ path alias instead of a relative import.',
        },
      ],
    },
  ],
  'check-file/folder-naming-convention': ['error', { '**/': 'KEBAB_CASE' }],
  'max-lines-per-function': [
    'warn',
    { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/', '**/dist/', 'node_modules/', '**/node_modules/', 'coverage/', '*.config.*'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // projectService resolves each file to its nearest tsconfig.json, the same one tsc uses.
        // The former `project` glob assigned some files to a program where workspace packages
        // did not resolve, which produced hundreds of "could not be resolved" no-unsafe hits.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'check-file': checkFile,
      sonarjs,
    },
    rules: {
      ...sonarjs_code_smell_rules,
      ...structural_convention_rules,
      ...type_aware_rules,
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{ts,tsx}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'parameter',
          format: ['snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        {
          selector: 'classProperty',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'classMethod',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
    },
  },
  {
    files: ['packages/*/tests/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'check-file': checkFile,
      sonarjs,
    },
    rules: {
      ...sonarjs_code_smell_rules,
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-identical-functions': 'off',
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'parameter',
          format: ['snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        {
          selector: 'classProperty',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'classMethod',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
    },
  },
  {
    files: ['packages/cli/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['packages/**/*.tsx'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['snake_case', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'variable',
          modifiers: ['destructured'],
          format: null,
        },
        {
          selector: 'function',
          format: ['snake_case', 'camelCase', 'PascalCase'],
        },
        {
          selector: 'parameter',
          format: ['snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'parameter',
          modifiers: ['destructured'],
          format: null,
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
    },
  },
  {
    files: ['packages/sdk/src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  prettierConfig,
);
