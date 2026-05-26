import axios from 'axios';
import { useAuthStore } from '../store/authStore';

export const API_BASE = import.meta.env.VITE_API_URL ?? 'https://api.zeehfi.ca';

const api = axios.create({ baseURL: API_BASE });

// Attach access token to every request
api.interceptors.request.use(config => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh on 401
let refreshing: Promise<void> | null = null;
api.interceptors.response.use(
  r => r,
  async err => {
    const original = err.config;
    if (
      err.response?.status === 401 &&
      err.response?.data?.code === 'TOKEN_EXPIRED' &&
      !original._retry
    ) {
      original._retry = true;
      if (!refreshing) {
        refreshing = useAuthStore.getState().refresh().finally(() => { refreshing = null; });
      }
      await refreshing;
      const token = useAuthStore.getState().accessToken;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
    }
    return Promise.reject(err);
  },
);

export default api;
