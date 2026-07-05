import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'test-results', 'playwright-report', '**/dist'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 조용한 실패 금지 — 프로젝트 전반의 원칙
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'off', // 타입 정보 필요 — 서버 구현 시 type-checked 프리셋으로 승격
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
