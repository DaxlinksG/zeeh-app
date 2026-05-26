import { create } from 'zustand';

type ToastType = 'ok' | 'err' | 'warn';
interface ToastItem { id: number; message: string; type: ToastType; }

interface ToastStore {
  toasts: ToastItem[];
  show:   (message: string, type?: ToastType) => void;
  remove: (id: number) => void;
}

let _id = 0;
export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, type = 'ok') => {
    const id = ++_id;
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 3000);
  },
  remove: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

export function toast(message: string, type: ToastType = 'ok') {
  useToast.getState().show(message, type);
}

export function ToastContainer() {
  const { toasts } = useToast();
  return (
    <div id="toast-root">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
      ))}
    </div>
  );
}
