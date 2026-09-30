import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { categoryErrorMessage, reorderCategories } from '../../_lib/categories.js';
import { authorize } from '../../_lib/authorize.js';

export async function onRequestPatch(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  try {
    const reordered = await reorderCategories(context.env, body?.category_ids);
    if (!reordered.ok) return badRequest(categoryErrorMessage(reordered, '카테고리 순서를 변경하지 못했습니다.'));
    return json({ categories: reordered.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
