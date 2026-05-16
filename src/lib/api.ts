const BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem('gpuviewr.token') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Handle a 401 from an authenticated route: clear the stored
 *  token + user, then redirect to /login?expired=1 so the login
 *  page can surface a "session expired" banner.
 *
 *  Skipped for /auth/* paths — those legitimately return 401 on
 *  wrong credentials, and the login form must show the error inline
 *  instead of looping back to itself.
 */
function handleUnauthorized(path: string): void {
  if (path.startsWith('/auth/')) return;
  if (!localStorage.getItem('gpuviewr.token')) return;
  localStorage.removeItem('gpuviewr.token');
  localStorage.removeItem('gpuviewr.user');
  // Full assign (not pushState) so the auth store re-hydrates from
  // the now-empty localStorage on the next mount. ?expired=1 is read
  // by the login page to render the banner.
  if (globalThis.location.pathname !== '/login') {
    globalThis.location.assign('/login?expired=1');
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(path);
    throw new ApiError(res.status, data?.error || res.statusText);
  }
  return data as T;
}
