import axios, { AxiosInstance, AxiosError } from 'axios';

function buildClient(): AxiosInstance {
  const client = axios.create({
    baseURL: process.env.GTP_BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });

  client.interceptors.request.use((config) => {
    const key = process.env.GTP_API_KEY;
    if (key) config.headers['X-API-Key'] = key;
    return config;
  });

  // Normalise GTP errors into a consistent shape
  client.interceptors.response.use(
    (res) => res,
    (err: AxiosError) => {
      const status = err.response?.status ?? 500;
      const body = err.response?.data as Record<string, unknown> | undefined;
      const message = (body?.message as string) ?? err.message ?? 'GTP API error';
      const gtpError = new Error(message) as Error & { status: number; upstream: unknown };
      gtpError.status = status;
      gtpError.upstream = body;
      return Promise.reject(gtpError);
    },
  );

  return client;
}

export const gtp = buildClient();
