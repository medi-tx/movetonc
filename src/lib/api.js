async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data?.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    error.code = data?.code;
    error.retryAfter = data?.retryAfter;
    throw error;
  }

  return data;
}

export const api = {
  state: () => request('/api/state'),
  setup: (payload) => request('/api/setup', { method: 'POST', body: JSON.stringify(payload) }),
  register: (payload) => request('/api/register', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => request('/api/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  unlock: (pin) => request('/api/unlock', { method: 'POST', body: JSON.stringify({ pin }) }),
  lock: () => request('/api/lock', { method: 'POST' }),
  createChannel: (payload) => request('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id, payload) =>
    request(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  messages: (channelId) => request(`/api/channels/${channelId}/messages`),
  sendMessage: (channelId, body) =>
    request(`/api/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ body }) }),
  deleteMessage: (id) => request(`/api/messages/${id}`, { method: 'DELETE' }),
  reportMessage: (id, reason) =>
    request(`/api/messages/${id}/report`, { method: 'POST', body: JSON.stringify({ reason }) }),
  reports: () => request('/api/reports'),
  resolveReport: (id) => request(`/api/reports/${id}/resolve`, { method: 'POST' }),
  updateSafety: (safety) => request('/api/settings', { method: 'PATCH', body: JSON.stringify({ safety }) }),
};
