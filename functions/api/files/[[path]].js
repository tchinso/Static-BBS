import { storageHandlers } from '../../_lib/storage-handlers.js';
const handlers = storageHandlers('files');
export const onRequestGet = handlers.download;
export const onRequestHead = handlers.download;
