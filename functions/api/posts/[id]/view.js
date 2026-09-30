import { json, serverError } from '../../../_lib/http.js';
import { incrementPostView, isUuid } from '../../../_lib/board.js';
import { authorize } from '../../../_lib/authorize.js';

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const id = context.params?.id;
  if (typeof id !== 'string' || !isUuid(id)) return json({ error: '글을 찾을 수 없습니다.' }, 404);
  try {
    const viewed = await incrementPostView(context.env, id);
    if (!viewed.ok) {
      return json({ error: '조회수를 반영하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    if (viewed.count === null) return json({ error: '글을 찾을 수 없습니다.' }, 404);
    return json({ viewed: true, viewCount: viewed.count }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
