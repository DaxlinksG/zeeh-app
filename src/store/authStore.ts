import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import axios from 'axios';
import { API_BASE } from '../lib/api';

interface AuthUser {
  user_id:        string;
  email:          string;
  first_name:     string;
  last_name:      string;
  kyc_status:     string;
  email_verified?: boolean;
  has_pin?:        boolean;
}

interface AuthState {
  user:         AuthUser | null;
  accessToken:  string | null;
  refreshToken: string | null;
  setAuth:      (user: AuthUser, access: string, refresh: string) => void;
  logout:       () => void;
  refresh:      () => Promise<void>;
  updateUser:   (partial: Partial<AuthUser>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user:         null,
      accessToken:  null,
      refreshToken: null,

      setAuth: (user: AuthUser, accessToken: string, refreshToken: string) =>
        set({ user, accessToken, refreshToken }),

      updateUser: (partial: Partial<AuthUser>) =>
        set((s: AuthState) => ({ user: s.user ? { ...s.user, ...partial } : s.user })),

      logout: () => {
        const rt = get().refreshToken;
        if (rt) {
          axios.post(`${API_BASE}/auth/logout`, { refresh_token: rt }).catch(() => {});
        }
        set({ user: null, accessToken: null, refreshToken: null });
      },

      refresh: async () => {
        const rt = get().refreshToken;
        if (!rt) throw new Error('No refresh token');
        const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refresh_token: rt });
        set({ accessToken: data.data.access_token, refreshToken: data.data.refresh_token });
      },
    }),
    {
      name:    'zeeh-auth',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
