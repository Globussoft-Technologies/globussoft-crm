# Plot Inventory API

## 1. Create an API key

1. Open [https://globuscrm.com/](https://globuscrm.com/) and sign in to the Generic CRM.
2. Open **Developer**.
3. Open **API Credentials**.
4. Enter a key name.
5. Select **Plot inventory (read-only)**.
6. Select **Generate Key**.
7. Copy the generated API key.

## 2. API endpoint

```text
GET https://globuscrm.com/api/v1/external/plot-inventory
```

## 3. Request headers

```http
Accept: application/json
X-API-Key: glbs_your_api_key
```

## 4. Request parameters

| Parameter          | Required | Description                                                                    |
| ------------------ | -------: | ------------------------------------------------------------------------------ |
| `q`                |       No | Searches name, plot number, block, address, reference code, and property type. |
| `availability`     |       No | `AVAILABLE`, `HOLD`, `BOOKED`, `REGISTERED`, `RESERVED`, or `SOLD`.            |
| `pickupLocationId` |       No | Filters plots assigned to the pickup location ID.                              |
| `limit`            |       No | Number of records. Default `50`, maximum `100`.                                |
| `offset`           |       No | Number of records to skip. Default `0`.                                        |

## 5. cURL request

```bash
curl --request GET "https://globuscrm.com/api/v1/external/plot-inventory?q=Green&availability=AVAILABLE&limit=50&offset=0" \
  --header "Accept: application/json" \
  --header "X-API-Key: glbs_your_api_key"
```

## 6. Response

```json
{
  "data": [
    {
      "id": 101,
      "name": "Green Valley Site A",
      "plotNumber": "A-102",
      "block": "A",
      "address": "Sarjapur Road, Bengaluru, Karnataka",
      "referenceCode": "GVS-A102",
      "area": 1350,
      "areaUnit": "sq ft",
      "roadWidth": 30,
      "facing": "East",
      "propertyType": "Plot",
      "price": 2850000,
      "availability": "AVAILABLE",
      "updatedAt": "2026-10-26T10:30:00.000Z",
      "pickupLocations": [
        {
          "id": 7,
          "name": "Green Valley Pickup Point",
          "address": "Sarjapur Road, Bengaluru",
          "googleMapsLink": "https://maps.google.com/?q=Sarjapur+Road"
        }
      ]
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "hasMore": false,
  "meta": {
    "vertical": "generic",
    "currency": "INR"
  }
}
```

## 7. Error response

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```
