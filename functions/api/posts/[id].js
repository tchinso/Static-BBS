import { scheduleStorageCleanup } from '../../_lib/storage-cleanup.js';
import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { deletePost, getPost, isUuid, makePostFields, patchPost, noticeLimitError, mediaValidationError, presentPost } from '../../_lib/board.js';
import { authorize } from '../../_lib/authorize.js';

function postId(context) {
  const id = context.params?.id;
  return typeof id === 'string' && isUuid(id) ? id : '';
}

function notFound() {
  return json({ error: '글을 찾을 수 없습니다.' }, 404);
}

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  const id = postId(context);
  if (!id) return notFound();
  try {
    const post = await getPost(context.env, id);
    if (!post) return notFound();
    return json({ post }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPatch(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const id = postId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  const prepared = makePostFields(body, context.env);
  if (prepared.error) return badRequest(prepared.error);
  try {
    const patched = await patchPost(context.env, id, prepared.fields);
    if (!patched.ok) {
      if (mediaValidationError(patched.detail)) return badRequest('첨부파일 정보나 총 용량을 확인해주세요. 업로드가 만료되었다면 파일을 다시 선택해주세요.');
      if (noticeLimitError(patched.detail)) return json({ error: '공지는 최대 2개까지만 설정할 수 있습니다.' }, 409);
      const detail = Array.isArray(patched.detail) ? patched.detail[0] : patched.detail;
      if (detail?.code === '23503') return badRequest('분류를 확인해주세요.');
      return json({ error: '글을 수정하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    if (!patched.data) return notFound();
    scheduleStorageCleanup(context);
    return json({
      post: presentPost(patched.data, context.env)
    }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestDelete(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const id = postId(context);
  if (!id) return notFound();
  try {
    const deleted = await deletePost(context.env, id);
    if (!deleted.ok) return json({ error: '글을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    if (!deleted.deleted) return notFound();
    scheduleStorageCleanup(context);
    return json({
      deleted: true
    }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
