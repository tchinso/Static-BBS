import { storageHandlers } from '../_lib/storage-handlers.js';
const handlers = storageHandlers('files');
export const onRequestPost = handlers.upload;
export const onRequestDelete = handlers.discard;
