/** E2E 실행 환경 설정. 값의 의미와 지정 방법은 docs/decisions.md 참고. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} 환경변수가 필요합니다. 로컬은 .env.e2e(예시: .env.e2e.example), ` +
        `CI는 GitHub Actions variables/secrets로 지정하세요.`,
    );
  }
  return value;
}

export const env = {
  /** 테스트 대상 devspace 서버 주소 */
  devspaceUrl: process.env.DEVSPACE_URL ?? 'http://localhost:3000',
  /** 시나리오가 클론/PR 대상으로 쓰는 테스트 전용 레포 (owner/name) */
  get e2eRepo(): string {
    return required('E2E_REPO');
  },
  /** 테스트 레포에만 권한이 있는 fine-grained PAT (검증·정리용) */
  get githubToken(): string {
    return required('E2E_GITHUB_TOKEN');
  },
};
