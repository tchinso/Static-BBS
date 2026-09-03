# 냥캣메모

Cloudflare Pages Functions와 Supabase를 사용하는 승인 사용자 전용 게시판입니다. 브라우저와 Git 저장소에는 Supabase URL, anon key, service-role key, 허용 이메일 목록을 넣지 않습니다.

## 보안 구조

- 브라우저는 Cloudflare Pages의 `/api/*`만 호출합니다.
- Supabase 자격 증명과 허용 이메일은 Cloudflare의 암호화된 Secret에서만 읽습니다.
- Supabase `Before User Created` hook과 RLS가 허용되지 않은 이메일의 가입·데이터 접근을 이중으로 차단합니다.
- 게시글과 이미지 버킷은 모두 비공개이며, 이미지는 로그인 세션을 확인하는 Pages Function을 거쳐 표시됩니다.
- 로그인 유지는 기본값입니다. 로그아웃하거나 브라우저 저장 데이터를 지우기 전까지, 서버 세션이 자동 갱신됩니다.

## Cloudflare Pages

Pages 프로젝트 `nkmm`은 `main` 브랜치를 자동 배포합니다. 빌드 명령과 출력 디렉터리는 비워 두고, Pages Functions를 포함하도록 저장소 루트를 배포합니다.

Production과 Preview 환경 모두에 다음 **Encrypted Secret**을 만듭니다.

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_EMAILS` — 쉼표·줄바꿈·세미콜론으로 구분한 정확한 이메일 주소 목록
- `SESSION_SECRET` — 충분히 긴 무작위 문자열

`ALLOWED_EMAILS`와 Supabase 키는 어떤 소스 파일이나 Cloudflare 일반 변수에도 넣지 마세요.

## Supabase

1. SQL Editor에서 [supabase-schema.sql](./supabase-schema.sql)을 실행합니다.
2. `private.community_allowed_email_hashes`에 허용 이메일의 SHA-256 값을 추가합니다. 원문 이메일은 SQL 파일에 기록하지 않습니다.
3. Authentication → Hooks에서 **Before User Created**에 `public.community_before_user_created` Postgres 함수를 선택합니다.
4. Authentication → URL Configuration에서 Site URL과 Redirect URL을 모두 `https://nkmm.pages.dev/`로 설정합니다.
5. Authentication → Sessions에서 time-box, inactivity timeout, single-session 강제 설정을 끄면 기본 로그인 유지가 장기 보존됩니다. 브라우저 쿠키·사이트 데이터 삭제는 언제나 로그아웃 효과가 있습니다.
6. Authentication → Emails → SMTP Settings에서 **Custom SMTP**를 설정합니다. Supabase 기본 SMTP는 조직 팀 멤버 주소에만 발송하므로, 이 게시판처럼 별도의 허용 목록으로 매직 링크를 보내는 운영 환경에서는 사용할 수 없습니다. SMTP 비밀번호·API 키는 저장소나 Cloudflare 변수에 기록하지 말고 Supabase의 SMTP 설정에만 입력합니다.
7. Authentication → Emails → Templates → **Magic link or OTP**의 본문은 `{{ .ConfirmationURL }}`로 직접 연결하지 말고, `{{ .SiteURL }}/auth/continue.html?confirmation_url={{ .ConfirmationURL }}`를 링크 대상으로 사용합니다. `auth/continue.html`의 사용자가 누르는 버튼이 실제 일회용 링크를 열므로, 이메일 보안 스캐너가 링크를 미리 소비하는 일을 막습니다.

## 운영 메모

- 승인 이메일을 추가하거나 제거할 때는 Cloudflare의 `ALLOWED_EMAILS`와 Supabase의 private hash 목록을 함께 갱신합니다.
- 모든 승인 계정은 `admin`입니다.
- 최상단 고정은 데이터베이스 차원에서 최대 2개로 제한됩니다.
- 게시글 분류는 `현생`, `링크`, `언어/검색어`, `리소스/아이디어`, `쥬우니/에카하나`만 사용할 수 있습니다.
- 이미지는 JPG, PNG, WebP, GIF 형식으로 한 장당 최대 25MB, 글당 최대 5장입니다. 게시글 삭제와 수정 중 이미지 제거는 Storage API로 실제 객체까지 함께 삭제합니다.
- GitHub Pages 배포는 사용하지 않습니다. 공개된 GitHub Pages 사이트가 남아 있다면 GitHub 저장소 Settings에서 Pages를 끄세요.
