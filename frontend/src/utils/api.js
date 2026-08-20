const BASE = import.meta.env.VITE_API_URL || ''
const TOKEN_KEY = 'chess-analyzer-token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The API sleeps after ~15 min idle on the free tier and takes ~30 s to wake.
// While it boots, fetch rejects outright (the platform's holding response carries
// no CORS headers), so keep retrying for longer than a cold start takes.
const WAKE_UP_BUDGET_MS = 60000

async function fetchWithWakeUp(url, init) {
  const deadline = Date.now() + WAKE_UP_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init)
    } catch {
      if (Date.now() >= deadline) {
        throw new ApiError(0, 'Serveur injoignable. Réessayez dans une minute.')
      }
      await sleep(Math.min(2000 * (attempt + 1), 8000))
    }
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (auth && token) headers.Authorization = `Bearer ${token}`

  const res = await fetchWithWakeUp(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 204) return null
  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    if (res.status === 401 && auth) setToken(null)
    const detail = data?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d) => d.msg).join(', ')
          : `Request failed (${res.status})`
    throw new ApiError(res.status, message)
  }
  return data
}

export const api = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload, auth: false }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload, auth: false }),
  me: () => request('/auth/me'),
  updateMe: (payload) => request('/auth/me', { method: 'PATCH', body: payload }),

  games: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    )
    return request(`/api/games?${qs}`)
  },
  game: (id) => request(`/api/games/${id}`),
  analysis: (id) => request(`/api/games/${id}/analysis`),
  refresh: (id) => request(`/api/games/${id}/refresh`, { method: 'POST' }),

  sync: (months = 1) => request(`/api/sync?months=${months}`, { method: 'POST' }),
  syncStatus: () => request('/api/sync/status'),

  stats: (days) => request(`/api/stats${days ? `?days=${days}` : ''}`),
  trends: (period = 'week', limit = 12) =>
    request(`/api/stats/trends?period=${period}&limit=${limit}`),
  mistakes: () => request('/api/stats/mistakes'),

  health: () => request('/api/health', { auth: false }),
}
