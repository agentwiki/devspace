/**
 * 아키텍처 경계 — 어기면 CI가 깨진다 (pnpm check:arch).
 *
 *   core     : 순수 도메인 + 포트. 아무것도 import할 수 없다 (node 내장 포함).
 *   adapters : 포트 구현. core만 알 수 있다.
 *   server   : 조립 루트. 유일하게 adapters를 꽂을 수 있는 곳.
 *   e2e      : 블랙박스. 앱 내부 코드를 import할 수 없다 — 브라우저와 GitHub으로만 검증.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '순환 의존 금지',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-stays-pure',
      comment: 'core는 순수 도메인 — 외부 패키지도, node 내장도, 다른 패키지도 import 금지',
      severity: 'error',
      from: { path: '^packages/core', pathNot: '\\.test\\.ts$' },
      to: { pathNot: '^packages/core' },
    },
    {
      name: 'adapters-know-only-core',
      comment: 'adapters는 core(와 외부 라이브러리)만 알 수 있다 — server/e2e 금지',
      severity: 'error',
      from: { path: '^packages/adapters' },
      to: { path: '^(apps|e2e)' },
    },
    {
      name: 'only-server-composes-adapters',
      comment: 'adapters를 import할 수 있는 곳은 조립 루트(server)뿐',
      severity: 'error',
      from: { pathNot: '^(apps/server|packages/adapters)' },
      to: { path: '^packages/adapters' },
    },
    {
      name: 'e2e-is-black-box',
      comment: 'e2e는 사용자 시나리오 — 앱 내부 구현을 import하지 않는다',
      severity: 'error',
      from: { path: '^e2e' },
      to: { path: '^(packages|apps)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
