# Cloudflare Pages Functions

Set these as **encrypted Cloudflare Pages secrets** for the production deployment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_EMAILS` (comma, newline, semicolon, or whitespace separated)
- `SESSION_SECRET` (a unique, high-entropy value of at least 32 characters)

No Supabase URL, anonymous key, service-role key, allowlist, access token, or refresh token belongs in frontend files. The browser calls only same-origin `/api/*` endpoints. The `__Host-nkmm_session` cookie is encrypted, HMAC-signed, `HttpOnly`, `Secure`, and `SameSite=Lax`; when `persistent` is omitted or true it has the longest broadly supported browser lifetime (400 days), subject to Supabase refresh-token validity.

In Supabase Authentication URL Configuration, add `https://nkmm.pages.dev/` to the Redirect URLs list. The login request endpoint always asks Supabase to return there.

Magic-link delivery additionally requires Supabase **Custom SMTP**. The hosted default SMTP only delivers to Supabase organization team members, so it is not suitable for this private allowlist. Keep SMTP credentials exclusively in Supabase Authentication → Emails → SMTP Settings.
