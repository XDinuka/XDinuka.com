import { getEditToken, clearEditToken, isUnlocked, unlockWithPin, API_BASE } from './auth.js';

// ─── Pure helpers (no Vue instance state needed) ───────────────────────────────

function isActiveCouple(rel) {
  return !rel || !rel.rel_subtype || rel.rel_subtype === 'married' || rel.rel_subtype === 'partner';
}

function getCoupleLabel(rel) {
  const labels = { married: 'Married', partner: 'Partners', ex: 'Ex-partners', divorced: 'Divorced', separated: 'Separated' };
  return labels[rel?.rel_subtype] ?? 'Couple';
}

function formatDates(dob, dod) {
  const birth = dob ? new Date(dob).getUTCFullYear() : '?';
  return dod ? `${birth} – ${new Date(dod).getUTCFullYear()}` : `b. ${birth}`;
}

function avg(nums) {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function basePath(d, stroke, dashed) {
  const path = svgEl('path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke', stroke);
  if (dashed) path.setAttribute('stroke-dasharray', '6,4');
  return path;
}

// Trunk/bus routing lines — neutral regardless of the underlying relationship's confirmed state.
function neutralPath(d, dashed) {
  return basePath(d, 'rgba(255,255,255,0.25)', dashed);
}

// Per-child riser — styled like the relationship it represents (confirmed color, subtype dash).
function relPath(d, rel) {
  const isBio = !rel.rel_subtype || rel.rel_subtype === 'biological';
  return basePath(d, rel.confirmed ? 'rgba(48,238,191,0.4)' : 'rgba(255,255,255,0.2)', !isBio);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── person-card component ─────────────────────────────────────────────────────

const PersonCard = {
  template: '#person-card-template',
  props: { person: { type: Object, required: true } },
  emits: ['open'],
  computed: {
    initials() {
      return this.person.full_name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    },
    formattedDates() {
      return formatDates(this.person.dob, this.person.dod);
    },
    photoSrc() {
      return `photos/${this.person.photo_id}.webp`;
    },
  },
  methods: {
    onImgError(e) {
      e.target.onerror = null;
      e.target.src = `${API_BASE}/photos/${this.person.photo_id}`;
    },
  },
};

// ─── Main app ───────────────────────────────────────────────────────────────────

const App = {
  data() {
    return {
      treeData: { allow_additions: true, people: [], relationships: [] },
      loading: true,
      loadError: false,
      editMode: isUnlocked(),
      collapsedNodes: [],
      draggingUnitKey: null,

      showAuthModal: false,
      pinInput: '',
      authError: '',
      unlockSubmitting: false,

      showEditModal: false,
      editingPerson: null,
      editPersonForm: { full_name: '', dob: '', dod: '', note: '' },
      editStatus: { text: '', ok: true, visible: false },
      editSubmitting: false,
      photoFile: null,

      activeTab: 'child',
      addMemberForm: { query: '', selectedExisting: null, dob: '', note: '', relSubtype: '' },
      addStatus: { text: '', ok: true, visible: false },
      addSubmitting: false,

      showAdditionsDisabledNotice: false,

      _resizeHandler: null,
    };
  },

  computed: {
    peopleById() {
      return new Map(this.treeData.people.map(p => [p.id, p]));
    },
    activePartner() {
      const map = new Map();
      for (const rel of this.treeData.relationships) {
        if (rel.rel_type !== 'couple') continue;
        for (const [a, b] of [[rel.person_a_id, rel.person_b_id], [rel.person_b_id, rel.person_a_id]]) {
          if (isActiveCouple(rel) && !map.has(a)) map.set(a, { partnerId: b, rel });
        }
      }
      return map;
    },
    allCoupleRels() {
      const map = new Map();
      for (const rel of this.treeData.relationships) {
        if (rel.rel_type !== 'couple') continue;
        for (const [a, b] of [[rel.person_a_id, rel.person_b_id], [rel.person_b_id, rel.person_a_id]]) {
          if (!map.has(a)) map.set(a, []);
          map.get(a).push({ partnerId: b, rel });
        }
      }
      return map;
    },
    childrenOf() {
      const map = new Map();
      for (const rel of this.treeData.relationships) {
        if (rel.rel_type !== 'parent_child') continue;
        if (!map.has(rel.person_a_id)) map.set(rel.person_a_id, []);
        map.get(rel.person_a_id).push({ childId: rel.person_b_id, rel });
      }
      return map;
    },
    parentsOfChild() {
      const map = new Map();
      for (const rel of this.treeData.relationships) {
        if (rel.rel_type !== 'parent_child') continue;
        if (!map.has(rel.person_b_id)) map.set(rel.person_b_id, new Map());
        map.get(rel.person_b_id).set(rel.person_a_id, rel);
      }
      return map;
    },
    generationsInOrder() {
      return [...new Set(this.treeData.people.map(p => p.generation))].sort((a, b) => a - b);
    },
    relSubtypeOptions() {
      return this.activeTab === 'partner'
        ? [['', 'Married (default)'], ['partner', 'Partner'], ['ex', 'Ex-partner'], ['divorced', 'Divorced'], ['separated', 'Separated']]
        : [['', 'Biological (default)'], ['adoptive', 'Adoptive'], ['step', 'Step'], ['foster', 'Foster']];
    },
    eligibleCandidates() {
      const q = this.addMemberForm.query.trim().toLowerCase();
      if (!q || !this.editingPerson) return [];
      const excluded = this.ineligibleIdsForTab(this.activeTab);
      return this.treeData.people
        .filter(p => !excluded.has(p.id) && p.full_name.toLowerCase().includes(q))
        .slice(0, 8);
    },
  },

  mounted() {
    this.loadTree();
    this._resizeHandler = debounce(() => this.drawConnectors(), 150);
    window.addEventListener('resize', this._resizeHandler);
  },

  unmounted() {
    window.removeEventListener('resize', this._resizeHandler);
  },

  methods: {
    isActiveCouple,
    getCoupleLabel,

    personById(id) {
      return this.peopleById.get(id);
    },

    async loadTree() {
      this.loading = true;
      this.loadError = false;
      try {
        const res = await fetch(`${API_BASE}/tree`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.treeData = await res.json();
        this.loading = false;
        this.$nextTick(() => this.drawConnectors());
      } catch {
        this.loading = false;
        this.loadError = true;
      }
    },

    // ─── Lock / unlock ────────────────────────────────────────────────────────

    toggleLock() {
      if (this.editMode) {
        clearEditToken();
        this.editMode = false;
      } else {
        this.pinInput = '';
        this.authError = '';
        this.showAuthModal = true;
        this.$nextTick(() => this.$refs.pinInput?.focus());
      }
    },

    async submitUnlock() {
      const pin = this.pinInput.trim();
      if (!pin) return;

      this.unlockSubmitting = true;
      this.authError = '';

      try {
        await unlockWithPin(pin);
        this.editMode = true;
        this.showAuthModal = false;
      } catch (err) {
        this.authError = err.message || 'Incorrect PIN. Please try again.';
        this.pinInput = '';
      } finally {
        this.unlockSubmitting = false;
      }
    },

    // ─── Generation layout ────────────────────────────────────────────────────

    unitKey(unit) {
      return unit.partnerId ? `${unit.primaryId}-${unit.partnerId}` : `${unit.primaryId}`;
    },

    unitsFor(gen) {
      const placed = new Set();
      const people = this.treeData.people
        .filter(p => p.generation === gen)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));

      const units = [];
      for (const person of people) {
        if (placed.has(person.id)) continue;
        placed.add(person.id);

        const ap = this.activePartner.get(person.id);
        const partner = ap && !placed.has(ap.partnerId) && this.peopleById.get(ap.partnerId)?.generation === gen
          ? this.peopleById.get(ap.partnerId)
          : null;

        if (partner) placed.add(partner.id);

        units.push({ primaryId: person.id, partnerId: partner?.id ?? null, coupleRel: ap?.rel ?? null });
      }
      return units;
    },

    childCountFor(unit) {
      const myKids      = this.childrenOf.get(unit.primaryId) ?? [];
      const partnerKids = unit.partnerId ? (this.childrenOf.get(unit.partnerId) ?? []) : [];
      return new Set([...myKids.map(c => c.childId), ...partnerKids.map(c => c.childId)]).size;
    },

    // ─── Expand / collapse ────────────────────────────────────────────────────

    getDescendants(primaryId, partnerId) {
      const result = new Set();
      const queue  = [];

      const enqueue = (parentId) => {
        for (const { childId } of this.childrenOf.get(parentId) ?? []) {
          if (result.has(childId)) continue;
          result.add(childId);
          queue.push(childId);
          const ap = this.activePartner.get(childId);
          if (ap) result.add(ap.partnerId);
        }
      };

      enqueue(primaryId);
      if (partnerId) enqueue(partnerId);

      while (queue.length) {
        const id = queue.shift();
        enqueue(id);
        const ap = this.activePartner.get(id);
        if (ap) enqueue(ap.partnerId);
      }

      return result;
    },

    getAncestors(personId) {
      const result = new Set();
      const queue   = [personId];

      while (queue.length) {
        const id = queue.shift();
        for (const parentId of this.parentsOfChild.get(id)?.keys() ?? []) {
          if (result.has(parentId)) continue;
          result.add(parentId);
          queue.push(parentId);
        }
      }

      return result;
    },

    isUnitHidden(unit) {
      for (const parentId of this.collapsedNodes) {
        const partnerId = this.activePartner.get(parentId)?.partnerId;
        const descendants = this.getDescendants(parentId, partnerId);
        if (descendants.has(unit.primaryId) || (unit.partnerId && descendants.has(unit.partnerId))) return true;
      }
      return false;
    },

    toggleSubtree(unit) {
      const idx = this.collapsedNodes.indexOf(unit.primaryId);
      if (idx === -1) this.collapsedNodes.push(unit.primaryId);
      else this.collapsedNodes.splice(idx, 1);
      this.$nextTick(() => this.drawConnectors());
    },

    // ─── Drag & drop reordering ───────────────────────────────────────────────

    onDragStart(unit) {
      this.draggingUnitKey = this.unitKey(unit);
    },

    onDragEnd() {
      this.draggingUnitKey = null;
      this.$nextTick(() => this.drawConnectors());
    },

    onDragOver(e, gen) {
      e.preventDefault();
      if (!this.draggingUnitKey) return;

      const rowEl = e.currentTarget;
      const siblingEls = [...rowEl.querySelectorAll('.family-unit')]
        .filter(el => el.dataset.unitKey !== this.draggingUnitKey);

      let targetIndex = siblingEls.length;
      for (let i = 0; i < siblingEls.length; i++) {
        const rect = siblingEls[i].getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) { targetIndex = i; break; }
      }

      const units = this.unitsFor(gen);
      const draggedIdx = units.findIndex(u => this.unitKey(u) === this.draggingUnitKey);
      if (draggedIdx === -1) return;

      const [dragged] = units.splice(draggedIdx, 1);
      units.splice(targetIndex, 0, dragged);

      let idx = 0;
      for (const unit of units) {
        const primary = this.peopleById.get(unit.primaryId);
        if (primary) primary.order_index = idx++;
        if (unit.partnerId) {
          const partner = this.peopleById.get(unit.partnerId);
          if (partner) partner.order_index = idx++;
        }
      }

      this.drawConnectors();
    },

    onDrop(gen) {
      if (!this.draggingUnitKey) return;
      this.persistOrder(gen);
    },

    async persistOrder(gen) {
      const order = [];
      for (const unit of this.unitsFor(gen)) {
        order.push(unit.primaryId);
        if (unit.partnerId) order.push(unit.partnerId);
      }

      try {
        const res = await fetch(`${API_BASE}/generations/${gen}/order`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getEditToken()}` },
          body: JSON.stringify({ order }),
        });
        if (!res.ok) throw new Error();
      } catch {
        this.loadTree();
      }
    },

    // ─── SVG connector lines ──────────────────────────────────────────────────

    buildParentGroups() {
      const groups = new Map(); // sorted parentIds key → { parentIds, children }

      for (const [childId, parentRels] of this.parentsOfChild) {
        const parentIds = [...parentRels.keys()].sort((a, b) => a - b);
        const key = parentIds.join(',');

        if (!groups.has(key)) groups.set(key, { parentIds, children: [] });
        groups.get(key).children.push({ childId, rel: parentRels.get(parentIds[0]) });
      }

      return [...groups.values()];
    },

    isActiveCoupleBetween(aId, bId) {
      return (this.allCoupleRels.get(aId) ?? []).some(({ partnerId, rel }) => partnerId === bId && isActiveCouple(rel));
    },

    drawConnectors() {
      const rootEl = this.$refs.treeRoot;
      if (!rootEl) return;

      document.getElementById('connector-svg')?.remove();

      const rootRect = rootEl.getBoundingClientRect();
      const svg = svgEl('svg');
      svg.id = 'connector-svg';
      svg.setAttribute('aria-hidden', 'true');

      for (const group of this.buildParentGroups()) {
        const parentCards = group.parentIds
          .map(id => rootEl.querySelector(`.person-card[data-person-id="${id}"]`))
          .filter(Boolean);
        if (!parentCards.length) continue;

        const parentRects  = parentCards.map(c => c.getBoundingClientRect());
        const dropX         = avg(parentRects.map(r => r.left + r.width / 2)) - rootRect.left;
        const coupleBottomY = parentRects[0].bottom - rootRect.top;

        const childPoints = [];
        for (const { childId, rel } of group.children) {
          const childCard = rootEl.querySelector(`.person-card[data-person-id="${childId}"]`);
          if (!childCard || childCard.closest('.family-unit')?.hidden) continue;
          const cRect = childCard.getBoundingClientRect();
          childPoints.push({
            x: cRect.left + cRect.width / 2 - rootRect.left,
            y: cRect.top - rootRect.top,
            rel,
          });
        }
        if (!childPoints.length) continue;

        const busY     = (coupleBottomY + childPoints[0].y) / 2;
        const xs       = [dropX, ...childPoints.map(c => c.x)];
        const minX     = Math.min(...xs);
        const maxX     = Math.max(...xs);
        const isCouple = group.parentIds.length === 1 || this.isActiveCoupleBetween(group.parentIds[0], group.parentIds[1]);

        svg.appendChild(neutralPath(`M${dropX},${coupleBottomY} L${dropX},${busY}`, !isCouple));
        if (maxX > minX) {
          svg.appendChild(neutralPath(`M${minX},${busY} L${maxX},${busY}`, !isCouple));
        }

        for (const { x, y, rel } of childPoints) {
          svg.appendChild(relPath(`M${x},${busY} L${x},${y}`, rel));
        }
      }

      rootEl.appendChild(svg);
    },

    // ─── Edit-person / add-member modal ────────────────────────────────────────

    openPersonEditor(person) {
      if (!this.editMode) return;
      if (!this.treeData.allow_additions) {
        this.showAdditionsDisabledNotice = true;
        return;
      }

      this.editingPerson = person;
      this.editPersonForm = { full_name: person.full_name, dob: person.dob ?? '', dod: person.dod ?? '', note: person.note ?? '' };
      this.editStatus.visible = false;
      this.photoFile = null;
      this.activeTab = 'child';
      this.resetAddMemberForm();
      this.showEditModal = true;
    },

    closeEditModal() {
      this.showEditModal = false;
      this.editingPerson = null;
    },

    switchTab(tab) {
      this.activeTab = tab;
      this.resetAddMemberForm();
    },

    resetAddMemberForm() {
      this.addMemberForm = { query: '', selectedExisting: null, dob: '', note: '', relSubtype: '' };
      this.addStatus.visible = false;
    },

    selectExisting(candidate) {
      this.addMemberForm.selectedExisting = candidate;
    },

    clearSelectedExisting() {
      this.addMemberForm.selectedExisting = null;
    },

    ineligibleIdsForTab(tab) {
      const person = this.editingPerson;
      const excluded = new Set([person.id]);

      if (tab === 'parent') {
        const partnerId = this.activePartner.get(person.id)?.partnerId;
        for (const id of this.getDescendants(person.id, partnerId)) excluded.add(id);
      } else if (tab === 'child') {
        for (const id of this.getAncestors(person.id)) excluded.add(id);
      }

      return excluded;
    },

    onPhotoChange(e) {
      this.photoFile = e.target.files[0] ?? null;
    },

    async submitEditPerson() {
      this.editSubmitting = true;
      this.editStatus.visible = false;
      const token = getEditToken();

      try {
        const body = {
          full_name: this.editPersonForm.full_name.trim(),
          dob:  this.editPersonForm.dob  || null,
          dod:  this.editPersonForm.dod  || null,
          note: this.editPersonForm.note.trim() || null,
        };

        const res = await fetch(`${API_BASE}/people/${this.editingPerson.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error();
        const { person: updated } = await res.json();
        Object.assign(this.editingPerson, updated);

        if (this.photoFile) {
          const fd = new FormData();
          fd.append('photo', this.photoFile);
          const pr = await fetch(`${API_BASE}/people/${this.editingPerson.id}/photo`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: fd,
          });
          if (pr.ok) {
            const { photo_id } = await pr.json();
            this.editingPerson.photo_id = photo_id;
          }
        }

        this.editStatus = { text: 'Saved!', ok: true, visible: true };
      } catch {
        this.editStatus = { text: 'Save failed. Please try again.', ok: false, visible: true };
      } finally {
        this.editSubmitting = false;
      }
    },

    async submitAddMember() {
      this.addSubmitting = true;
      this.addStatus.visible = false;

      const tab   = this.activeTab;
      const form  = this.addMemberForm;
      const token = getEditToken();

      try {
        if (form.selectedExisting) {
          const target   = form.selectedExisting;
          const endpoint = tab === 'parent' ? 'link-parent' : tab === 'child' ? 'link-child' : 'link-partner';
          const idField  = tab === 'parent' ? 'parent_id'  : tab === 'child' ? 'child_id'  : 'partner_id';

          const res = await fetch(`${API_BASE}/people/${this.editingPerson.id}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ [idField]: target.id, rel_subtype: form.relSubtype || null }),
          });
          if (!res.ok) {
            const { error } = await res.json().catch(() => ({}));
            throw new Error(error || 'Failed');
          }

          const data = await res.json();
          this.treeData.relationships.push(data.relationship);
          this.addStatus = { text: `${target.full_name} linked as ${tab} — awaiting verification.`, ok: true, visible: true };
        } else {
          const name = form.query.trim();
          if (!name) throw new Error('Enter a name.');

          const endpoint = tab === 'child' ? 'children' : tab === 'parent' ? 'parent' : 'partner';
          const res = await fetch(`${API_BASE}/people/${this.editingPerson.id}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              full_name:   name,
              dob:         form.dob || null,
              note:        form.note.trim() || null,
              rel_subtype: form.relSubtype || null,
            }),
          });
          if (!res.ok) {
            const { error } = await res.json().catch(() => ({}));
            throw new Error(error || 'Failed');
          }

          const data = await res.json();
          this.treeData.people.push(data.person);
          this.treeData.relationships.push(data.relationship);
          this.addStatus = { text: `${data.person.full_name} added — awaiting verification.`, ok: true, visible: true };
        }

        this.resetAddMemberForm();
        this.$nextTick(() => this.drawConnectors());
      } catch (err) {
        this.addStatus = { text: err.message || 'Failed to add. Please try again.', ok: false, visible: true };
      } finally {
        this.addSubmitting = false;
      }
    },
  },
};

Vue.createApp(App).component('person-card', PersonCard).mount('#app');
