# 짱현무의 기술 블로그

[Astro](https://astro.build/) + [AstroPaper](https://github.com/satnaing/astro-paper) 기반의 정적 블로그.
GitHub Pages 로 [zzanghyunmoo.github.io](https://zzanghyunmoo.github.io) 에 배포됩니다.

## 개발

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # dist/ 에 정적 파일 생성
npm run preview   # 빌드 결과 미리보기
```

## 새 글 작성

`src/data/blog/<slug>.md` 파일을 만들고 frontmatter를 채웁니다:

```markdown
---
title: 글 제목
author: 짱현무
pubDatetime: 2026-06-09T10:00:00+09:00
slug: my-first-post
description: 요약 설명
tags:
  - tag1
  - tag2
featured: false
draft: false
---

본문은 여기에 마크다운으로.
```

옵션:

- `featured: true` — 홈 상단에 강조
- `draft: true` — 빌드에 포함되지 않음
- `ogImage: "./image.png"` — 사용자 정의 OG 이미지

## Wiki 글과 공개 승격

별도 문서 엔진을 두지 않고 일반 글의 `tags`에 `wiki`를 추가하면 `/wiki`, 전체 글,
태그, RSS, Pagefind가 같은 원본을 사용합니다.

private note에서 글을 승격할 때는 다음을 지킵니다.

1. private wikilink, embed, block reference, 절대 경로, secret, local attachment를 제거합니다.
2. 일반 Markdown 링크와 위 frontmatter 계약으로 정규화합니다.
3. 공개 branch push 전에 workspace의 publication guard로 신규 commit 전체를 검사합니다.
4. `npm run build && npm run test:knowledge`로 `/wiki`, RSS, Pagefind를 확인합니다.

private vault를 이 저장소의 submodule, symlink, content loader로 연결하지 않습니다.

## 배포

`v4` 브랜치에 push 하면 `.github/workflows/deploy.yml` 이 자동으로:

1. `npm ci && npm run build`
2. `dist/` 를 GitHub Pages 아티팩트로 업로드
3. Pages 환경에 배포

## 사이트 설정

- `src/config.ts` — 사이트 제목/저자/도메인/언어 등
- `src/constants.ts` — 소셜 링크
- `src/pages/about.md` — About 페이지
- `src/pages/index.astro` — 홈 인트로

## 라이선스

[MIT](LICENSE) — AstroPaper 테마 라이선스 계승.
