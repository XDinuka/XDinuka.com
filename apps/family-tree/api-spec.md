# Family Tree — API Specification

This documents the external REST API that backs the family tree page at `https://xdinuka.com/family-tree/`. The API is hosted separately and connects to a MariaDB database.

---

## Base URL

```
https://api.xdinuka.com/family-tree
```

_(Replace with the actual host when deployed.)_

---

## Authentication

There is a single global edit PIN for the whole tree — no per-person PINs. All mutation endpoints require a JWT:

```
Authorization: Bearer <token>
```

Tokens are issued by `POST /auth/unlock`, expire in **1 hour**, and grant edit access to the **entire tree** — any person, any relationship, not scoped to one record. The frontend stores the token for the duration of an "edit mode" session and discards it when the user re-locks the page.

**JWT payload:**
```json
{ "editor": true, "exp": 1718400000 }
```

---

## CORS

All responses must include:

```
Access-Control-Allow-Origin: https://xdinuka.com
Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## Error format

All errors use:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|--------|---------|
| 400 | Validation failure |
| 401 | Missing, invalid, or expired token |
| 404 | Resource not found |
| 422 | Business rule violation (e.g. person already has an active partner, or a cyclic relationship) |
| 503 | Additions are currently disabled (`allow_additions = false` in settings) |

---

## Endpoints

### `GET /tree`

Returns the full tree. No authentication required. Called once on page load.

**Response 200:**
```json
{
  "allow_additions": true,
  "people": [
    {
      "id": 1,
      "full_name": "Grandfather",
      "dob": "1940-03-15",
      "dod": null,
      "note": "Patriarch of the family.",
      "photo_id": "550e8400-e29b-41d4-a716-446655440000",
      "generation": 0,
      "order_index": 0,
      "confirmed": true
    }
  ],
  "relationships": [
    {
      "id": 1,
      "person_a_id": 1,
      "person_b_id": 2,
      "rel_type": "couple",
      "rel_subtype": null,
      "confirmed": true
    }
  ]
}
```

`allow_additions` is read from the `settings` table. When `false`, the frontend disables all add/edit flows.

---

### `POST /auth/unlock`

Verifies the single global edit PIN and returns a JWT that unlocks editing for the whole tree.

**Rate limit:** 10 requests per minute per IP.

**Request:**
```json
{ "pin": "1234" }
```

**Response 200:**
```json
{ "token": "eyJ...", "expires_in": 3600 }
```

**Response 401:**
```json
{ "error": "Invalid PIN" }
```

---

### `PATCH /people/:id`

Updates any person's record. Requires a valid edit token (not scoped to that person). All fields are optional.

**Request:**
```json
{
  "full_name": "Updated Name",
  "dob": "1975-06-12",
  "dod": null,
  "note": "Updated note."
}
```

**Response 200:**
```json
{
  "ok": true,
  "person": {
    "id": 7,
    "full_name": "Updated Name",
    "dob": "1975-06-12",
    "dod": null,
    "note": "Updated note.",
    "photo_id": "550e8400-e29b-41d4-a716-446655440000",
    "generation": 1,
    "order_index": 0,
    "confirmed": true
  }
}
```

`confirmed`, `generation`, and `order_index` are not updatable via this endpoint — `order_index` changes go through `PUT /generations/:gen/order` below.

---

### `POST /people/:id/photo`

Uploads a photo for the given person. Requires a valid edit token. Generates a UUID v4 as the photo key, stores the binary in the `photos` table, and updates `people.photo_id`.

**Request:** `multipart/form-data` with a field named `photo`.

- Accepted MIME types: `image/jpeg`, `image/png`, `image/webp`
- Max size: **5 MB**

**Response 200:**
```json
{ "photo_id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Response 413:**
```json
{ "error": "File too large. Maximum 5 MB." }
```

---

### `POST /people/:id/children`

Adds a child of the given person. Requires a valid edit token. Returns 503 if `allow_additions = false`.

**Request:**
```json
{
  "full_name": "Child Name",
  "dob": "2005-01-20",
  "note": "",
  "rel_subtype": "biological"
}
```

`rel_subtype` options: `biological` (default / omit for default), `adoptive`, `step`, `foster`.

The new person is inserted with `confirmed = 0`, `generation = parent.generation + 1`, and `order_index = max(order_index) + 1` among that generation's existing people.

**Response 201:**
```json
{
  "person": {
    "id": 42,
    "full_name": "Child Name",
    "dob": "2005-01-20",
    "dod": null,
    "note": "",
    "photo_id": null,
    "generation": 2,
    "order_index": 1,
    "confirmed": false
  },
  "relationship": {
    "id": 17,
    "person_a_id": 7,
    "person_b_id": 42,
    "rel_type": "parent_child",
    "rel_subtype": "biological",
    "confirmed": false
  }
}
```

---

### `POST /people/:id/parent`

Adds a parent of the given person. Requires a valid edit token. Returns 503 if `allow_additions = false`.

**Request:**
```json
{
  "full_name": "Parent Name",
  "dob": "1940-03-15",
  "note": "",
  "rel_subtype": "biological"
}
```

`rel_subtype` options: `biological` (default / omit for default), `adoptive`, `step`, `foster`.

The new person is inserted with `confirmed = 0`, `generation = child.generation - 1`, and `order_index = max(order_index) + 1` among that generation's existing people.

**Response 201:**
```json
{
  "person": {
    "id": 44,
    "full_name": "Parent Name",
    "dob": "1940-03-15",
    "dod": null,
    "note": "",
    "photo_id": null,
    "generation": 0,
    "order_index": 2,
    "confirmed": false
  },
  "relationship": {
    "id": 19,
    "person_a_id": 44,
    "person_b_id": 7,
    "rel_type": "parent_child",
    "rel_subtype": "biological",
    "confirmed": false
  }
}
```

Note that `person_a_id` is the new parent and `person_b_id` is the target person — the reverse of `POST /people/:id/children`.

---

### `POST /people/:id/link-parent`

Links an **already-existing** person in the tree as a parent of the given person, instead of creating a new one. Requires a valid edit token. Used for cases like two existing siblings who should share an existing mother. Returns 503 if `allow_additions = false`.

**Request:**
```json
{
  "parent_id": 6,
  "rel_subtype": "biological"
}
```

`rel_subtype` options: `biological` (default / omit for default), `adoptive`, `step`, `foster`.

No new `people` row is created — only the `relationships` row, inserted with `confirmed = 0`.

**Response 201:**
```json
{
  "relationship": {
    "id": 20,
    "person_a_id": 6,
    "person_b_id": 7,
    "rel_type": "parent_child",
    "rel_subtype": "biological",
    "confirmed": false
  }
}
```

**Response 400:** `{ "error": "parent_id is required" }` or `{ "error": "A person cannot be their own parent" }`

**Response 404:** `{ "error": "Parent not found" }` — `parent_id` doesn't match an existing person.

**Response 422:** `{ "error": "This would create a cycle" }` — `parent_id` is a descendant of the target person (would make someone their own ancestor). The API must walk the `parent_child` graph from `parent_id` downward and reject if it reaches `id`.

---

### `POST /people/:id/link-child`

Links an **already-existing** person in the tree as a child of the given person, instead of creating a new one. Requires a valid edit token. The reverse of `POST /people/:id/link-parent`. Returns 503 if `allow_additions = false`.

**Request:**
```json
{
  "child_id": 9,
  "rel_subtype": "biological"
}
```

`rel_subtype` options: `biological` (default / omit for default), `adoptive`, `step`, `foster`.

No new `people` row is created — only the `relationships` row, inserted with `confirmed = 0`, `person_a_id = :id` (parent), `person_b_id = child_id` (child).

**Response 201:**
```json
{
  "relationship": {
    "id": 21,
    "person_a_id": 7,
    "person_b_id": 9,
    "rel_type": "parent_child",
    "rel_subtype": "biological",
    "confirmed": false
  }
}
```

**Response 400:** `{ "error": "child_id is required" }` or `{ "error": "A person cannot be their own child" }`

**Response 404:** `{ "error": "Child not found" }` — `child_id` doesn't match an existing person.

**Response 422:** `{ "error": "This would create a cycle" }` — `child_id` is an **ancestor** of the target person (the reverse direction of the `link-parent` check). The API must walk the `parent_child` graph from `child_id` upward (via `person_b_id → person_a_id` edges) and reject if it reaches `id`.

---

### `POST /people/:id/partner`

Adds a partner (couple relationship) for the given person. Requires a valid edit token. Returns 503 if `allow_additions = false`.

Returns 422 if the target person already has an active (`married` or `partner`) couple relationship.

**Request:**
```json
{
  "full_name": "Partner Name",
  "dob": "1978-09-03",
  "note": "",
  "rel_subtype": "married"
}
```

`rel_subtype` options: `married` (default), `partner`, `ex`, `divorced`, `separated`.

**Response 201:**
```json
{
  "person": {
    "id": 43,
    "full_name": "Partner Name",
    "dob": "1978-09-03",
    "dod": null,
    "note": "",
    "photo_id": null,
    "generation": 1,
    "order_index": 2,
    "confirmed": false
  },
  "relationship": {
    "id": 18,
    "person_a_id": 7,
    "person_b_id": 43,
    "rel_type": "couple",
    "rel_subtype": "married",
    "confirmed": false
  }
}
```

The new partner is assigned the same `generation` as the target person, and `order_index = max(order_index) + 1` within that generation.

---

### `POST /people/:id/link-partner`

Links an **already-existing** person in the tree as a partner (couple relationship) of the given person, instead of creating a new one. Requires a valid edit token. Returns 503 if `allow_additions = false`.

Returns 422 if the target person already has an active (`married` or `partner`) couple relationship and `rel_subtype` is `married`/`partner` — same business rule as `POST /people/:id/partner`.

**Request:**
```json
{
  "partner_id": 12,
  "rel_subtype": "married"
}
```

`rel_subtype` options: `married` (default), `partner`, `ex`, `divorced`, `separated`.

No new `people` row is created — only the `relationships` row, inserted with `confirmed = 0`. The API normalizes `person_a_id`/`person_b_id` to the existing "smaller id first" convention — the frontend just sends `partner_id` and doesn't need to know the ordering.

**Response 201:**
```json
{
  "relationship": {
    "id": 22,
    "person_a_id": 7,
    "person_b_id": 12,
    "rel_type": "couple",
    "rel_subtype": "married",
    "confirmed": false
  }
}
```

**Response 400:** `{ "error": "partner_id is required" }` or `{ "error": "A person cannot be their own partner" }`

**Response 404:** `{ "error": "Partner not found" }` — `partner_id` doesn't match an existing person.

---

### `PUT /generations/:gen/order`

Reorders all people within one generation (drag & drop on the frontend). Requires a valid edit token. Returns 503 if `allow_additions = false`.

**Request:**
```json
{ "order": [3, 4, 9] }
```

`order` must be the full, ordered list of person IDs currently in generation `:gen` — every person in that generation, no more, no less. The API rewrites `order_index` to match array position (`order[0]` → `0`, `order[1]` → `1`, …) inside a transaction (see `data-structure.md` for the unique-key collision pitfall when doing this row by row).

**Response 200:**
```json
{ "ok": true }
```

**Response 400:** `{ "error": "order must include every person in this generation exactly once" }`

---

### `GET /photos/:id`

Serves a photo by UUID directly from the database. Used as fallback when the static WebP file isn't available yet.

**Response 200:** Binary image data with appropriate `Content-Type` header.

**Response 404:** `{ "error": "Photo not found" }`

---

## Backend implementation notes

- **`allow_additions` check:** Read from the `settings` table on every `POST /people/:id/children`, `POST /people/:id/parent`, `POST /people/:id/link-parent`, `POST /people/:id/link-child`, `POST /people/:id/partner`, `POST /people/:id/link-partner`, and `PUT /generations/:gen/order` request. Return 503 immediately if `value = 'false'`.
- **Global edit token:** Every mutation endpoint (`PATCH /people/:id`, `POST /people/:id/photo`, `POST /people/:id/children`, `POST /people/:id/parent`, `POST /people/:id/link-parent`, `POST /people/:id/link-child`, `POST /people/:id/partner`, `POST /people/:id/link-partner`, `PUT /generations/:gen/order`) just needs *any* valid, unexpired token from `POST /auth/unlock` — there is no per-person ownership check anymore.
- **Cycle checks:** `link-parent` walks descendants of `parent_id` (reject if `id` is found); `link-child` walks ancestors of `child_id` (reject if `id` is found) — same traversal, opposite direction. These are the only two endpoints that link two pre-existing people into a `parent_child` row, so they're the only ones that can introduce a cycle. `link-partner` has no cycle concept (couple relationships aren't directional).
- **`confirmed` flag:** All new `people` and `relationships` rows are inserted with `confirmed = 0`. To confirm an entry, set `confirmed = 1` directly in the database. There is no API endpoint for confirmation — this is intentional.
- **Partner uniqueness:** Before inserting a new `couple` relationship with `rel_subtype` of `married` or `partner` (via either `POST /people/:id/partner` or `POST /people/:id/link-partner`), check that no existing active couple relationship exists for `person_a_id`. Return 422 if one does. `ex`/`divorced`/`separated` subtypes are always allowed.
- **`order_index` assignment on insert:** New people get `order_index = COALESCE(MAX(order_index), -1) + 1` for their target generation, so they're appended to the end rather than colliding with an existing value.
- **Photo UUID:** Use UUID v4 (e.g. Node.js `crypto.randomUUID()`, Python `uuid.uuid4()`). Store in `photos.id` as CHAR(36).
