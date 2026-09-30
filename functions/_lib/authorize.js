import { crossSiteRequest, isSameOriginRequest, serverError, unauthorized } from './http.js';
import { getAuthorizedSession } from './session.js';

// Every API uses the same origin/session gate. A Response stops the handler.
export async function authorize(context, { mutation = false } = {}) {
  if (mutation && !isSameOriginRequest(context.request)) return { response: crossSiteRequest() };
  try {
    const auth = await getAuthorizedSession(context.request, context.env);
    return auth.ok ? { auth } : { response: unauthorized({ 'Set-Cookie': auth.clearCookie }) };
  } catch {
    return { response: serverError() };
  }
}

export const sessionHeaders = (auth) => auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined;
