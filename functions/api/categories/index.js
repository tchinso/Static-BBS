import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { categoryErrorMessage, createCategory, listCategories } from '../../_lib/categories.js';
import { authorize } from '../../_lib/authorize.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try {
    const categories = await listCategories(context.env, { includePostCount: true });
    return json({ categories }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  try {
    const created = await createCategory(context.env, body?.name);
    if (!created.ok) return badRequest(categoryErrorMessage(created, '카테고리를 추가하지 못했습니다.'));
    return json({ category: created.data }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
