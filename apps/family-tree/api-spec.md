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

Mutation endpoints require a per-person JWT:

```
Authorization: Bearer <token>
```

Tokens are issued by `POST /auth`, expire in **1 hour**, and are scoped to a single `person_id`. A person can only modify their own record or add family members related to themselves.

**JWT payload:**
```json
{ "person_id": 7, "exp": 1718400000 }
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
| 401 | Missing or expired token |
| 403 | Token exists but `person_id` doesn't match the target |
| 404 | Resource not found |
| 422 | Business rule violation (e.g. person already has an active partner) |
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

### `POST /auth`

Verifies a person's PIN and returns a JWT.

**Rate limit:** 10 requests per minute per IP.

**Request:**
```json
{ "person_id": 7, "pin": "1234" }
```

**Response 200:**
```json
{ "token": "eyJ...", "person_id": 7, "expires_in": 3600 }
```

**Response 401:**
```json
{ "error": "Invalid PIN" }
```

---

### `PATCH /people/:id`

Updates the authenticated person's own record. All fields are optional.

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
    "confirmed": true
  }
}
```

The API validates `token.person_id === parseInt(id)`. `confirmed` and `generation` are not updatable via this endpoint.

---

### `POST /people/:id/photo`

Uploads a photo for the authenticated person. Generates a UUID v4 as the photo key, stores the binary in the `photos` table, and updates `people.photo_id`.

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

Adds a child of the authenticated person. Returns 503 if `allow_additions = false`.

**Request:**
```json
{
  "full_name": "Child Name",
  "dob": "2005-01-20",
  "note": "",
  "pin": "5678",
  "rel_subtype": "biological"
}
```

`rel_subtype` options: `biological` (default / omit for default), `adoptive`, `step`, `foster`.

The new person is inserted with `confirmed = 0` and `generation = parent.generation + 1`. The PIN is bcrypt-hashed before storage.

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

### `POST /people/:id/partner`

Adds a partner (couple relationship) for the authenticated person. Returns 503 if `allow_additions = false`.

Returns 422 if the authenticated person already has an active (`married` or `partner`) couple relationship.

**Request:**
```json
{
  "full_name": "Partner Name",
  "dob": "1978-09-03",
  "note": "",
  "pin": "9999",
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

The new partner is assigned the same `generation` as the authenticated person.

---

### `GET /photos/:id`

Serves a photo by UUID directly from the database. Used as fallback when the static WebP file isn't available yet.

**Response 200:** Binary image data with appropriate `Content-Type` header.

**Response 404:** `{ "error": "Photo not found" }`

---

## Backend implementation notes

- **`allow_additions` check:** Read from the `settings` table on every `POST /people/:id/children` and `POST /people/:id/partner` request. Return 503 immediately if `value = 'false'`.
- **`confirmed` flag:** All new `people` and `relationships` rows are inserted with `confirmed = 0`. To confirm an entry, set `confirmed = 1` directly in the database. There is no API endpoint for confirmation — this is intentional.
- **Partner uniqueness:** Before inserting a new `couple` relationship with `rel_subtype` of `married` or `partner`, check that no existing active couple relationship exists for `person_a_id`. Return 422 if one does. `ex`/`divorced`/`separated` subtypes are always allowed.
- **Photo UUID:** Use UUID v4 (e.g. Node.js `crypto.randomUUID()`, Python `uuid.uuid4()`). Store in `photos.id` as CHAR(36).
