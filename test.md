# Analysis API Test Documentation

Base URL: `http://localhost:5000/api/analysis`

## 1. Create or Update Analysis (Upsert)

**Endpoint:** `POST /api/analysis`

**Description:** 
Checks if an analysis of the specified `analysis_type` already exists for the `business_id`.
- If **exists**: Updates the record.
- If **does not exist**: Creates a new record.
- **Validates**: Checks if `business_id` exists in `user_businesses` collection.

**Curl:**
```bash
curl -X POST http://localhost:5000/api/analysis \
  -H "Content-Type: application/json" \
  -d '{
    "business_id": "65c3f1e8b2a1a9c4d8e5f2a1", 
    "phase": "discovery",
    "analysis_type": "swot",
    "analysis_name": "Q1 Strategy SWOT",
    "analysis_data": {
        "strengths": ["Agile team", "Modern stack"],
        "weaknesses": ["Limited marketing budget"],
        "opportunities": ["New market expansion"],
        "threats": ["Competitor X"]
    }
  }'
```
*Note: Replace `business_id` with a valid ObjectId.*

**Expected Success Response (New Creation - 201 Created):**
```json
{
    "success": true,
    "message": "Analysis created successfully",
    "id": "65c3f2...",
    "is_update": false
}
```

**Expected Success Response (Update - 200 OK):**
```json
{
    "success": true,
    "message": "Analysis updated successfully",
    "id": "65c3f2...",
    "is_update": true
}
```

**Error Response (404 Business Not Found):**
```json
{
    "success": false,
    "error": "Business not found"
}
```

**Error Response (400 Bad Request):**
```json
{
    "success": false,
    "error": "Missing required fields..."
}
```

---

## 2. Get All Analysis for Business

**Endpoint:** `GET /api/analysis/business/:businessId`

**Curl:**
```bash
curl http://localhost:5000/api/analysis/business/65c3f1e8b2a1a9c4d8e5f2a1
```

**Expected Success Response (200 OK):**
```json
{
    "success": true,
    "count": 1,
    "data": [
        {
            "_id": "65c3f2...",
            "business_id": "65c3f1e8b2a1a9c4d8e5f2a1",
            "phase": "discovery",
            "analysis_type": "swot",
            "analysis_name": "Q1 Strategy SWOT",
            "analysis_data": { ... },
            "created_at": "2024-02-07T12:00:00.000Z"
        }
    ]
}
```

**Error Response (404 Business Not Found):**
```json
{
    "success": false,
    "error": "Business not found"
}
```

---

## 3. Get Analysis by Phase

**Endpoint:** `GET /api/analysis/business/:businessId/phase/:phase`

**Curl:**
```bash
curl http://localhost:5000/api/analysis/business/65c3f1e8b2a1a9c4d8e5f2a1/phase/discovery
```

**Expected Success Response (200 OK):**
```json
{
    "success": true,
    "count": 1,
    "data": [ ... ]
}
```

---

## 4. Get Analysis by Filter

**Endpoint:** `GET /api/analysis/business/:businessId/filter?type=...&name=...`

**Curl (Filter by Type):**
```bash
curl "http://localhost:5000/api/analysis/business/65c3f1e8b2a1a9c4d8e5f2a1/filter?type=swot"
```

**Curl (Filter by Name):**
```bash
curl "http://localhost:5000/api/analysis/business/65c3f1e8b2a1a9c4d8e5f2a1/filter?name=Q1%20Strategy%20SWOT"
```

**Expected Success Response (200 OK):**
```json
{
    "success": true,
    "count": 1,
    "data": [ ... ]
}
```
