import { scheduleStorageCleanup } from '../../_lib/storage-cleanup.js';
import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { createPost, ensureAdminProfile, listPosts, makePostFields, noticeLimitError, mediaValidationError, presentPost } from '../../_lib/board.js';
import { authorize } from '../../_lib/authorize.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try {
    const posts = await listPosts(context.env);
    return json({ posts }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  try {
    const profile = await ensureAdminProfile(context.env, auth.user);
    const prepared = makePostFields(body, context.env, { creating: true, profile, user: auth.user });
    if (prepared.error) return badRequest(prepared.error);
    const created = await createPost(context.env, prepared.fields);
    if (!created.ok) {
      if (mediaValidationError(created.detail)) return badRequest('첨부파일 정보나 총 용량을 확인해주세요. 업로드가 만료되었다면 파일을 다시 선택해주세요.');
      if (noticeLimitError(created.detail)) return json({ error: '공지는 최대 2개까지만 설정할 수 있습니다.' }, 409);
      const detail = Array.isArray(created.detail) ? created.detail[0] : created.detail;
      if (detail?.code === '23503') return badRequest('분류를 확인해주세요.');
      return json({ error: '글을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    scheduleStorageCleanup(context);
    return json({ post: presentPost(created.data, context.env) }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
