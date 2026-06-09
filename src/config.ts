export const SITE = {
  website: "https://zzanghyunmoo.github.io/",
  author: "짱현무",
  profile: "https://github.com/zzanghyunmoo",
  desc: "짱현무의 기술 블로그",
  title: "Zzang Hyun Moo",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 5,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/zzanghyunmoo/zzanghyunmoo.github.io/edit/v4/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "ko",
  timezone: "Asia/Seoul",
} as const;
