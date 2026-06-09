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
