import { authUnavailable, crossSiteRequest, isSameOriginRequest, serverError, unauthorized } from './http.js';
import { getAuthorizedSession } from './session.js';
import { AuthServiceUnavailable } from './supabase.js';

// Every API uses the same origin/session gate. A Response stops the handler.
export async function authorize(context, { mutation = false, onFreshSession } = {}) {
  if (mutation && !isSameOriginRequest(context.request)) return { response: crossSiteRequest() };
  try {
    const auth = await getAuthorizedSession(context.request, context.env, { onFreshSession });
    if (!auth.ok) return { response: unauthorized() };
    if (context.data && auth.setCookie) context.data.rotatedSessionCookie = auth.setCookie;
    return { auth };
  } catch (error) {
    return { response: error instanceof AuthServiceUnavailable ? authUnavailable() : serverError() };
  }
}

export const sessionHeaders = (auth) => auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined;
