/**
 * ═══════════════════════════════════════════════════════════
 * ESLint Configuration - WhatsApp Clinic Bot
 * 
 * Enforces code quality and consistency
 * Based on Airbnb style guide with customizations
 * ═══════════════════════════════════════════════════════════
 */

module.exports = {
  env: {
    node: true,
    es2021: true,
    commonjs: true,
  },
  
  extends: [
    'airbnb-base',
    'plugin:node/recommended',
    'prettier', // Disables ESLint rules that conflict with Prettier
  ],
  
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  
  plugins: [
    'node',
    'import',
  ],
  
  rules: {
    // ═══════════════════════════════════════════════════════
    // GENERAL
    // ═══════════════════════════════════════════════════════
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'warn',
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_' 
    }],
    'no-use-before-define': ['error', { 
      functions: false,
      classes: true,
      variables: true 
    }],
    
    // ═══════════════════════════════════════════════════════
    // ASYNC/AWAIT
    // ═══════════════════════════════════════════════════════
    'require-await': 'error',
    'no-return-await': 'error',
    'prefer-promise-reject-errors': 'error',
    
    // ═══════════════════════════════════════════════════════
    // ERROR HANDLING
    // ═══════════════════════════════════════════════════════
    'no-throw-literal': 'error',
    'prefer-destructuring': ['error', {
      array: false,
      object: true
    }],
    
    // ═══════════════════════════════════════════════════════
    // IMPORTS
    // ═══════════════════════════════════════════════════════
    'import/order': ['error', {
      groups: [
        'builtin',
        'external',
        'internal',
        'parent',
        'sibling',
        'index'
      ],
      'newlines-between': 'always',
      alphabetize: {
        order: 'asc',
        caseInsensitive: true
      }
    }],
    'import/prefer-default-export': 'off',
    'import/no-dynamic-require': 'warn',
    
    // ═══════════════════════════════════════════════════════
    // NODE.JS SPECIFIC
    // ═══════════════════════════════════════════════════════
    'node/no-unsupported-features/es-syntax': 'off',
    'node/no-missing-require': 'error',
    'node/no-unpublished-require': 'off',
    'node/no-extraneous-require': 'error',
    
    // ═══════════════════════════════════════════════════════
    // CODE STYLE
    // ═══════════════════════════════════════════════════════
    'arrow-body-style': ['error', 'as-needed'],
    'prefer-arrow-callback': 'error',
    'prefer-const': 'error',
    'prefer-template': 'error',
    'object-shorthand': 'error',
    'quote-props': ['error', 'as-needed'],
    
    // ═══════════════════════════════════════════════════════
    // RELAXED RULES (for flexibility)
    // ═══════════════════════════════════════════════════════
    'consistent-return': 'off',
    'no-underscore-dangle': 'off',
    'no-param-reassign': ['error', { 
      props: false 
    }],
    'func-names': 'off',
    'max-len': ['warn', { 
      code: 120,
      ignoreComments: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true
    }],
    
    // ═══════════════════════════════════════════════════════
    // SECURITY
    // ═══════════════════════════════════════════════════════
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
  },
  
  // ═══════════════════════════════════════════════════════
  // FILE OVERRIDES
  // ═══════════════════════════════════════════════════════
  overrides: [
    {
      // Test files
      files: ['**/*.test.js', '**/*.spec.js', 'test/**/*.js', 'tests/**/*.js'],
      env: {
        jest: true,
        mocha: true,
      },
      rules: {
        'no-unused-expressions': 'off',
        'max-len': 'off',
      },
    },
    {
      // Scripts
      files: ['scripts/**/*.js'],
      rules: {
        'no-console': 'off',
        'import/no-dynamic-require': 'off',
      },
    },
    {
      // Configuration files
      files: ['*.config.js', '.eslintrc.js'],
      env: {
        node: true,
      },
      rules: {
        'global-require': 'off',
      },
    },
  ],
  
  // ═══════════════════════════════════════════════════════
  // IGNORED PATTERNS
  // ═══════════════════════════════════════════════════════
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    'logs/',
    'backups/',
    'temp/',
    '*.min.js',
  ],
};

/**
 * ═══════════════════════════════════════════════════════════
 * USAGE
 * ═══════════════════════════════════════════════════════════
 * 
 * Install dependencies:
 *   npm install --save-dev eslint eslint-config-airbnb-base 
 *   eslint-plugin-import eslint-plugin-node eslint-config-prettier
 * 
 * Run linting:
 *   npm run lint
 *   npm run lint:fix
 * 
 * VS Code integration:
 *   Install "ESLint" extension
 *   Add to settings.json:
 *   {
 *     "editor.codeActionsOnSave": {
 *       "source.fixAll.eslint": true
 *     }
 *   }
 * 
 * Pre-commit hook (optional):
 *   npm install --save-dev husky lint-staged
 *   npx husky install
 *   npx husky add .husky/pre-commit "npx lint-staged"
 * 
 * Add to package.json:
 *   "lint-staged": {
 *     "*.js": ["eslint --fix", "git add"]
 *   }
 * 
 * ═══════════════════════════════════════════════════════════
 */
