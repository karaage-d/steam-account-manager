import { reactive } from 'vue';

export const toasts = reactive([]);
let seq = 0;

export function toast(message, opts = {}) {
  const id = ++seq;
  const item = {
    id,
    message,
    title: opts.title || '',
    detail: opts.detail || '',
    kind: opts.kind || 'info',       // info | success | warn | error | milestone
    icon: opts.icon || '',
    duration: opts.duration ?? 4000,
  };
  toasts.push(item);
  if (item.duration > 0) setTimeout(() => dismiss(id), item.duration);
  // 最多同时 4 条
  while (toasts.length > 4) toasts.shift();
  return id;
}

export function dismiss(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export const toastSuccess = (m, o) => toast(m, { ...o, kind: 'success' });
export const toastError = (m, o) => toast(m, { ...o, kind: 'error', duration: 6000 });
export const toastWarn = (m, o) => toast(m, { ...o, kind: 'warn' });
