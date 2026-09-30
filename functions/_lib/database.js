import { supabaseJson } from './supabase.js';

export const restQuery = (table, query) => `/rest/v1/${table}?${new URLSearchParams(query)}`;
export const firstRow = (data) => Array.isArray(data) ? data[0] || null : null;
export const rpc = (env, name, body) => supabaseJson(env, `/rest/v1/rpc/${name}`, { method: 'POST', body });
export const detailOf = (result) => Array.isArray(result?.detail) ? result.detail[0] : result?.detail;
