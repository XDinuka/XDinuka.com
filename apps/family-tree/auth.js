// export const API_BASE = 'https://api.xdinuka.com/family-tree';
export const API_BASE = 'http://localhost:3000';

const TOKEN_KEY = 'ft_edit_token';

export function getEditToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearEditToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function isUnlocked() {
  return !!getEditToken();
}

export async function unlockWithPin(pin) {
  const res = await fetch(`${API_BASE}/auth/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });

  if (!res.ok) throw new Error('Incorrect PIN. Please try again.');

  const { token } = await res.json();
  sessionStorage.setItem(TOKEN_KEY, token);
  return token;
}
