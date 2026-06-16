import { getToken, openAuthModal, API_BASE } from './auth.js';

let treeData      = { allow_additions: true, people: [], relationships: [] };
let allowAdditions = true;
const collapsedNodes = new Set();

// Indexes rebuilt after every data change
let peopleById    = new Map(); // id → person
let activePartner = new Map(); // person_id → { partnerId, rel }
let allCoupleRels = new Map(); // person_id → [{ partnerId, rel }]
let childrenOf    = new Map(); // parent_id → [{ childId, rel }]

document.addEventListener('DOMContentLoaded', () => {
  loadTree();
  document.getElementById('retry-btn')?.addEventListener('click', loadTree);
  window.addEventListener('resize', debounce(drawConnectors, 150));
});

async function loadTree() {
  show('tree-loading');
  hide('tree-error');
  document.getElementById('tree-root').innerHTML = '';

  try {
    const res = await fetch(`${API_BASE}/tree`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    treeData = await res.json();
    allowAdditions = treeData.allow_additions !== false;
    buildIndexes();
    hide('tree-loading');
    renderTree();
  } catch {
    hide('tree-loading');
    show('tree-error');
  }
}

function buildIndexes() {
  peopleById    = new Map(treeData.people.map(p => [p.id, p]));
  activePartner = new Map();
  allCoupleRels = new Map();
  childrenOf    = new Map();

  for (const rel of treeData.relationships) {
    if (rel.rel_type === 'couple') {
      for (const [a, b] of [[rel.person_a_id, rel.person_b_id], [rel.person_b_id, rel.person_a_id]]) {
        if (!allCoupleRels.has(a)) allCoupleRels.set(a, []);
        allCoupleRels.get(a).push({ partnerId: b, rel });

        if (isActiveCouple(rel) && !activePartner.has(a)) {
          activePartner.set(a, { partnerId: b, rel });
        }
      }
    }

    if (rel.rel_type === 'parent_child') {
      if (!childrenOf.has(rel.person_a_id)) childrenOf.set(rel.person_a_id, []);
      childrenOf.get(rel.person_a_id).push({ childId: rel.person_b_id, rel });
    }
  }
}

function isActiveCouple(rel) {
  return !rel.rel_subtype || rel.rel_subtype === 'married' || rel.rel_subtype === 'partner';
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTree() {
  const root = document.getElementById('tree-root');
  root.innerHTML = '';

  if (!treeData.people.length) {
    root.innerHTML = '<p class="tree-empty">No family members yet.</p>';
    return;
  }

  const generations = [...new Set(treeData.people.map(p => p.generation))].sort((a, b) => a - b);

  for (const gen of generations) {
    const row = document.createElement('div');
    row.className = 'gen-row';
    row.dataset.generation = gen;

    const placed = new Set();
    const genPeople = treeData.people.filter(p => p.generation === gen);

    for (const person of genPeople) {
      if (placed.has(person.id)) continue;
      placed.add(person.id);

      const ap = activePartner.get(person.id);
      const partner = ap && !placed.has(ap.partnerId) && peopleById.get(ap.partnerId)?.generation === gen
        ? peopleById.get(ap.partnerId)
        : null;

      if (partner) placed.add(partner.id);

      row.appendChild(buildUnit(person, partner, ap?.rel ?? null));
    }

    root.appendChild(row);
  }

  // Restore collapsed state after re-render
  for (const parentId of collapsedNodes) {
    const descendants = getDescendants(parentId, activePartner.get(parentId)?.partnerId);
    for (const id of descendants) {
      const unit = document.querySelector(`.person-card[data-person-id="${id}"]`)?.closest('.family-unit');
      if (unit) unit.hidden = true;
    }
    const btn = document.querySelector(`.expand-btn[data-parent-id="${parentId}"]`);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  drawConnectors();
}

function buildUnit(primary, partner, coupleRel) {
  const unit = document.createElement('div');
  unit.className = 'family-unit';

  const coupleRow = document.createElement('div');
  coupleRow.className = 'couple-row';
  coupleRow.appendChild(buildCard(primary));

  if (partner) {
    const conn = document.createElement('span');
    conn.className = 'couple-connector';
    conn.setAttribute('aria-hidden', 'true');
    conn.title = getCoupleLabel(coupleRel);

    const active = isActiveCouple(coupleRel);
    conn.textContent = active ? '♥' : '✕';
    conn.classList.add(active ? 'connector-active' : 'connector-ex');
    if (!coupleRel.confirmed) conn.classList.add('connector-unconfirmed');

    coupleRow.appendChild(conn);
    coupleRow.appendChild(buildCard(partner));
  }

  unit.appendChild(coupleRow);

  // Combine children from both parents to determine if expand button is needed
  const myKids      = childrenOf.get(primary.id) ?? [];
  const partnerKids = partner ? (childrenOf.get(partner.id) ?? []) : [];
  const childIds    = new Set([...myKids.map(c => c.childId), ...partnerKids.map(c => c.childId)]);

  if (childIds.size > 0) {
    const btn = document.createElement('button');
    btn.className = 'expand-btn';
    btn.dataset.parentId = primary.id;
    btn.setAttribute('aria-expanded', 'true');
    btn.innerHTML = `<span class="expand-icon">▾</span><span class="expand-label"> ${childIds.size} ${childIds.size === 1 ? 'child' : 'children'}</span>`;
    btn.addEventListener('click', () => toggleSubtree(primary.id, partner?.id));
    unit.appendChild(btn);
  }

  return unit;
}

function buildCard(person) {
  const card = document.createElement('div');
  card.className = 'person-card' + (person.confirmed ? '' : ' unconfirmed');
  card.dataset.personId = person.id;

  const btn = document.createElement('button');
  btn.className = 'person-photo-btn';
  btn.setAttribute('aria-label', `${person.confirmed ? 'Edit' : 'View'} ${person.full_name}`);

  if (person.photo_id) {
    const img = document.createElement('img');
    img.className = 'person-photo';
    img.alt = person.full_name;
    img.src = `photos/${person.photo_id}.webp`;
    img.onerror = function () {
      this.onerror = null;
      this.src = `${API_BASE}/photos/${person.photo_id}`;
    };
    btn.appendChild(img);
  } else {
    btn.appendChild(buildAvatar(person.full_name));
  }

  btn.addEventListener('click', () => {
    if (!person.confirmed) {
      openSimpleModal('unconfirmed-notice', el => {
        el.querySelector('#unconfirmed-notice-name').textContent = person.full_name;
      });
      return;
    }
    openAuthModal(person, token => openEditModal(person, token));
  });

  card.appendChild(btn);

  const name = el('p', 'person-name', person.full_name);
  card.appendChild(name);

  if (person.dob || person.dod) {
    card.appendChild(el('p', 'person-dates', formatDates(person.dob, person.dod)));
  }

  if (person.note) {
    const note = el('p', 'person-note', person.note);
    note.title = person.note;
    card.appendChild(note);
  }

  if (!person.confirmed) {
    card.appendChild(el('span', 'unconfirmed-badge', 'Pending'));
  }

  return card;
}

function buildAvatar(name) {
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const svg = svgEl('svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('width', '80');
  svg.setAttribute('height', '80');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('person-photo', 'person-avatar');

  const circle = svgEl('circle');
  circle.setAttribute('cx', '40'); circle.setAttribute('cy', '40');
  circle.setAttribute('r', '40'); circle.setAttribute('fill', '#2e2e50');

  const text = svgEl('text');
  text.setAttribute('x', '50%'); text.setAttribute('y', '50%');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('fill', '#30eebf');
  text.setAttribute('font-size', '28');
  text.setAttribute('font-family', 'Inter, sans-serif');
  text.setAttribute('font-weight', '600');
  text.textContent = initials;

  svg.appendChild(circle);
  svg.appendChild(text);
  return svg;
}

// ─── SVG connector lines ──────────────────────────────────────────────────────

function drawConnectors() {
  document.getElementById('connector-svg')?.remove();

  const rootEl   = document.getElementById('tree-root');
  const rootRect = rootEl.getBoundingClientRect();

  const svg = svgEl('svg');
  svg.id = 'connector-svg';
  svg.setAttribute('aria-hidden', 'true');

  for (const rel of treeData.relationships) {
    if (rel.rel_type !== 'parent_child') continue;
    if (collapsedNodes.has(rel.person_a_id)) continue;

    const parentCard = document.querySelector(`.person-card[data-person-id="${rel.person_a_id}"]`);
    const childCard  = document.querySelector(`.person-card[data-person-id="${rel.person_b_id}"]`);
    if (!parentCard || !childCard) continue;

    const pRect = parentCard.getBoundingClientRect();
    const cRect = childCard.getBoundingClientRect();

    const x1   = pRect.left + pRect.width  / 2 - rootRect.left;
    const y1   = pRect.bottom - rootRect.top;
    const x2   = cRect.left  + cRect.width  / 2 - rootRect.left;
    const y2   = cRect.top   - rootRect.top;
    const midY = (y1 + y2) / 2;

    const path = svgEl('path');
    path.setAttribute('d', `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke', rel.confirmed ? 'rgba(48,238,191,0.4)' : 'rgba(255,255,255,0.2)');

    const isBio = !rel.rel_subtype || rel.rel_subtype === 'biological';
    if (!isBio) path.setAttribute('stroke-dasharray', '6,4');

    svg.appendChild(path);
  }

  rootEl.appendChild(svg);
}

// ─── Expand / collapse ────────────────────────────────────────────────────────

function toggleSubtree(primaryId, partnerId) {
  const nowCollapsing = !collapsedNodes.has(primaryId);
  nowCollapsing ? collapsedNodes.add(primaryId) : collapsedNodes.delete(primaryId);

  const descendants = getDescendants(primaryId, partnerId);
  for (const id of descendants) {
    const unit = document.querySelector(`.person-card[data-person-id="${id}"]`)?.closest('.family-unit');
    if (unit) unit.hidden = nowCollapsing;
  }

  const btn = document.querySelector(`.expand-btn[data-parent-id="${primaryId}"]`);
  if (btn) btn.setAttribute('aria-expanded', String(!nowCollapsing));

  drawConnectors();
}

function getDescendants(primaryId, partnerId) {
  const result = new Set();
  const queue  = [];

  const enqueue = (parentId) => {
    for (const { childId } of childrenOf.get(parentId) ?? []) {
      if (result.has(childId)) continue;
      result.add(childId);
      queue.push(childId);
      const ap = activePartner.get(childId);
      if (ap) result.add(ap.partnerId);
    }
  };

  enqueue(primaryId);
  if (partnerId) enqueue(partnerId);

  while (queue.length) {
    const id = queue.shift();
    enqueue(id);
    const ap = activePartner.get(id);
    if (ap) enqueue(ap.partnerId);
  }

  return result;
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

function openEditModal(person, token) {
  if (!allowAdditions) {
    openSimpleModal('additions-disabled-notice');
    return;
  }

  const modal      = document.getElementById('edit-modal');
  const editForm   = document.getElementById('edit-form');
  const addForm    = document.getElementById('add-member-form');
  const editStatus = document.getElementById('edit-status');
  const addStatus  = document.getElementById('add-status');

  editForm.elements.full_name.value = person.full_name;
  editForm.elements.dob.value       = person.dob  ?? '';
  editForm.elements.dod.value       = person.dod  ?? '';
  editForm.elements.note.value      = person.note ?? '';
  editStatus.hidden = true;

  addForm.reset();
  addForm.elements.member_type.value = 'child';
  addStatus.hidden = true;
  switchTab('child');

  modal.hidden = false;
  editForm.querySelector('[type="submit"]').focus();

  const closeBtn = modal.querySelector('.modal-close');
  const backdrop = modal.querySelector('.modal-backdrop');

  function hideModal() {
    modal.hidden = true;
    editForm.onsubmit = null;
    addForm.onsubmit  = null;
    closeBtn.removeEventListener('click', hideModal);
    backdrop.removeEventListener('click', hideModal);
  }

  closeBtn.addEventListener('click', hideModal);
  backdrop.addEventListener('click', hideModal);

  modal.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      addForm.elements.member_type.value = tab;
      switchTab(tab);
    };
  });

  editForm.onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = editForm.querySelector('[type="submit"]');
    setWorking(submitBtn, 'Saving…');
    editStatus.hidden = true;

    try {
      const body = {
        full_name: editForm.elements.full_name.value.trim(),
        dob:  editForm.elements.dob.value  || null,
        dod:  editForm.elements.dod.value  || null,
        note: editForm.elements.note.value.trim() || null,
      };

      const res = await fetch(`${API_BASE}/people/${person.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const { person: updated } = await res.json();
      Object.assign(person, updated);

      const photoFile = editForm.elements.photo.files[0];
      if (photoFile) {
        const fd = new FormData();
        fd.append('photo', photoFile);
        const pr = await fetch(`${API_BASE}/people/${person.id}/photo`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd,
        });
        if (pr.ok) {
          const { photo_id } = await pr.json();
          person.photo_id = photo_id;
        }
      }

      renderTree();
      editStatus.textContent = 'Saved!';
      editStatus.className = 'form-status form-status--ok';
      editStatus.hidden = false;
    } catch {
      editStatus.textContent = 'Save failed. Please try again.';
      editStatus.className = 'form-status form-status--err';
      editStatus.hidden = false;
    } finally {
      setWorking(submitBtn, 'Save', false);
    }
  };

  addForm.onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn  = addForm.querySelector('[type="submit"]');
    const memberType = addForm.elements.member_type.value;
    setWorking(submitBtn, 'Adding…');
    addStatus.hidden = true;

    try {
      const body = {
        full_name:   addForm.elements.full_name.value.trim(),
        dob:         addForm.elements.dob.value || null,
        note:        addForm.elements.note.value.trim() || null,
        pin:         addForm.elements.pin.value,
        rel_subtype: addForm.elements.rel_subtype.value || null,
      };

      const endpoint = memberType === 'child'
        ? `${API_BASE}/people/${person.id}/children`
        : `${API_BASE}/people/${person.id}/partner`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || 'Failed');
      }

      const data = await res.json();
      treeData.people.push(data.person);
      treeData.relationships.push(data.relationship);
      buildIndexes();
      renderTree();

      addForm.reset();
      switchTab(memberType);
      addStatus.textContent = `${data.person.full_name} added — awaiting verification.`;
      addStatus.className = 'form-status form-status--ok';
      addStatus.hidden = false;
    } catch (err) {
      addStatus.textContent = err.message || 'Failed to add. Please try again.';
      addStatus.className = 'form-status form-status--err';
      addStatus.hidden = false;
    } finally {
      setWorking(submitBtn, 'Add', false);
    }
  };
}

function switchTab(tab) {
  document.querySelectorAll('#edit-modal .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const select = document.getElementById('rel-subtype');
  select.innerHTML = '';

  const options = tab === 'child'
    ? [['', 'Biological (default)'], ['adoptive', 'Adoptive'], ['step', 'Step'], ['foster', 'Foster']]
    : [['', 'Married (default)'], ['partner', 'Partner'], ['ex', 'Ex-partner'], ['divorced', 'Divorced'], ['separated', 'Separated']];

  for (const [value, label] of options) {
    const opt = document.createElement('option');
    opt.value   = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}

// ─── Simple notice modals ─────────────────────────────────────────────────────

function openSimpleModal(id, setup) {
  const modal    = document.getElementById(id);
  const closeBtn = modal.querySelector('.modal-close');
  const backdrop = modal.querySelector('.modal-backdrop');

  setup?.(modal);
  modal.hidden = false;

  function hide() {
    modal.hidden = true;
    closeBtn.removeEventListener('click', hide);
    backdrop.removeEventListener('click', hide);
  }

  closeBtn.addEventListener('click', hide);
  backdrop.addEventListener('click', hide);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDates(dob, dod) {
  const birth = dob ? new Date(dob).getUTCFullYear() : '?';
  return dod ? `${birth} – ${new Date(dod).getUTCFullYear()}` : `b. ${birth}`;
}

function getCoupleLabel(rel) {
  const labels = { married: 'Married', partner: 'Partners', ex: 'Ex-partners', divorced: 'Divorced', separated: 'Separated' };
  return labels[rel?.rel_subtype] ?? 'Couple';
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function show(id) { document.getElementById(id).hidden = false; }
function hide(id) { document.getElementById(id).hidden = true; }

function setWorking(btn, label, disabled = true) {
  btn.disabled    = disabled;
  btn.textContent = label;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
