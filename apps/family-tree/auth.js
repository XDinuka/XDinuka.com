// Set to true and populate tree-data.json to run without the API
export const STATIC_MODE = false;

export const API_BASE = 'https://api.xdinuka.com/family-tree';

export function getToken(personId) {
  return sessionStorage.getItem(`ft_token_${personId}`);
}

export function clearToken(personId) {
  sessionStorage.removeItem(`ft_token_${personId}`);
}

export function openAuthModal(person, onSuccess) {
  const existing = getToken(person.id);
  if (existing) {
    onSuccess(existing);
    return;
  }

  const modal    = document.getElementById('auth-modal');
  const nameEl   = document.getElementById('auth-modal-name');
  const pinInput = document.getElementById('pin-input');
  const errorEl  = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const closeBtn = modal.querySelector('.modal-close');
  const backdrop = modal.querySelector('.modal-backdrop');

  nameEl.textContent = `Enter PIN for ${person.full_name}`;
  pinInput.value = '';
  errorEl.hidden = true;
  modal.hidden = false;

  const prevFocus = document.activeElement;
  pinInput.focus();

  function hide() {
    modal.hidden = true;
    prevFocus?.focus();
    detach();
  }

  async function submit() {
    const pin = pinInput.value.trim();
    if (!pin) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying…';
    errorEl.hidden = true;

    try {
      const res = await fetch(`${API_BASE}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_id: person.id, pin }),
      });

      if (res.ok) {
        const { token } = await res.json();
        sessionStorage.setItem(`ft_token_${person.id}`, token);
        modal.hidden = true;
        detach();
        prevFocus?.focus();
        onSuccess(token);
      } else {
        errorEl.hidden = false;
        pinInput.value = '';
        pinInput.focus();
      }
    } catch {
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock';
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter') submit();
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input')];
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  function detach() {
    submitBtn.removeEventListener('click', submit);
    closeBtn.removeEventListener('click', hide);
    backdrop.removeEventListener('click', hide);
    pinInput.removeEventListener('keydown', onKeydown);
    modal.removeEventListener('keydown', trapFocus);
  }

  submitBtn.addEventListener('click', submit);
  closeBtn.addEventListener('click', hide);
  backdrop.addEventListener('click', hide);
  pinInput.addEventListener('keydown', onKeydown);
  modal.addEventListener('keydown', trapFocus);
}
