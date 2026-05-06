import type { ApiEnvelope } from '../types/analysis';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const API_BASIC_AUTH_TOKEN = import.meta.env.VITE_API_BASIC_AUTH_TOKEN || '';

export async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: API_BASIC_AUTH_TOKEN
      ? { Authorization: `Basic ${API_BASIC_AUTH_TOKEN}` }
      : undefined
  });
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }
  const envelope = await response.json() as ApiEnvelope<T>;
  return envelope.data;
}
