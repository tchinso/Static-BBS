# Cloudflare Pages Functions

Set these as **encrypted Cloudflare Pages secrets** for the production deployment:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_EMAILS` (comma, newline, semicolon, or whitespace separated)
- `SESSION_SECRET` (a unique, high-entropy value of at least 32 characters)

No Supabase URL, anonymous key, service-role key, allowlist, access token, or refresh token belongs in frontend files. The browser calls only same-origin `/api/*` endpoints. The `__Host-nkmm_session` cookie is encrypted, HMAC-signed, `HttpOnly`, `Secure`, and `SameSite=Lax`; when `persistent` is omitted or true it has the longest broadly supported browser lifetime (400 days), subject to Supabase refresh-token validity.

In Supabase Authentication URL Configuration, add `https://nkmm.pages.dev/` to the Redirect URLs list. The login request endpoint always asks Supabase to return there.

Magic-link delivery additionally requires Supabase **Custom SMTP**. The hosted default SMTP only delivers to Supabase organization team members, so it is not suitable for this private allowlist. Keep SMTP credentials exclusively in Supabase Authentication → Emails → SMTP Settings.

Media routes share `storage-handlers.js`. Files use the private `community-files` bucket; images use `community-images`. Apply `20260930-attachments-storage.sql` before deploying the attachment routes. Database metadata enforces eight attachments and a combined 25MiB limit independently of images.

Uploads reserve durable cleanup before bytes are sent. Cleanup runs through Storage API in `waitUntil`, with leases and retries. An unused upload has a one-hour grace period; cleanup resumes on the next authorized board activity. Downloads authenticate and check a live post reference before using Cloudflare's edge cache. Browser and service-worker caches never retain private API responses. See `../MAINTENANCE.md` for invariants and regression checks.
