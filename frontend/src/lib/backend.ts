// Server-side access to the Python backend. The shared secret proves the
// request came through this app, which applies the usage limits.
const backendUrl = (
  process.env.UNEP_AI_BACKEND_URL ||
  process.env.NEXT_PUBLIC_UNEP_AI_BACKEND_URL ||
  "http://127.0.0.1:8000"
).replace(/\/$/, "");

export function backendFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (process.env.INTERNAL_API_SECRET) {
    headers.set("X-Internal-Secret", process.env.INTERNAL_API_SECRET);
  }
  return fetch(`${backendUrl}${path}`, { ...init, headers });
}
