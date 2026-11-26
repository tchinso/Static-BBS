import { serverError } from '../_lib/http.js';

export async function onRequest(context) {
  let response;
  try {
    response = await context.next();
  } catch {
    response = serverError();
  }
  const cookie = context.data.rotatedSessionCookie;
  // Keep the refreshed session even if the protected operation later fails.
  if (cookie && !response.headers.has('Set-Cookie')) {
    response = new Response(response.body, response);
    response.headers.set('Set-Cookie', cookie);
  }
  return response;
}
