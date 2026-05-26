# Mapbox Setup Instructions

## Your Mapbox Token

**IMPORTANT**: Replace `YOUR_MAPBOX_TOKEN_HERE` with your actual Mapbox public token.

Get your free token at: https://account.mapbox.com/access-tokens/

```
YOUR_MAPBOX_TOKEN_HERE
```

## Setup Methods (Choose One)

### Option A: EAS Secrets (Recommended for Production)

First, add your token as an EAS secret:

```bash
cd frontend
eas secret create MAPBOX_ACCESS_TOKEN=YOUR_ACTUAL_TOKEN_HERE
```

Then remove the token from `eas.json` and update `frontend/config/mapbox.ts`.

This is the **recommended** method because:
- Token is encrypted and never exposed in code
- Works with all EAS build profiles (preview, production)
- Easy to rotate/remove later

### Option B: Direct in eas.json (Current Setup)

The token placeholder has been added to `eas.json` in the build profiles:

```json
"production": {
  "env": {
    "MAPBOX_ACCESS_TOKEN": "YOUR_MAPBOX_TOKEN_HERE"
  }
}
```

Replace `YOUR_MAPBOX_TOKEN_HERE` with your actual Mapbox public token.

### Option C: Local Development

Create a `.env` file in the frontend folder:
```
MAPBOX_ACCESS_TOKEN=YOUR_ACTUAL_TOKEN_HERE
```

Then restart Expo: `npx expo start --clear`

---

## Building with Mapbox

### Preview Build (Testing)
```bash
cd frontend
eas build --profile preview --platform android
```

### Production Build (Release)
```bash
cd frontend
eas build --profile production --platform android
```

---

## Mapbox Free Tier Limits

| Feature | Monthly Limit |
|---------|---------------|
| Map loads | 50,000 |
| Tile requests | 500,000 |
| Static maps API | 50,000 |
| Geocoding | 100,000 |

For a security team app, this is more than sufficient.

---

## Features You Get

✅ **Satellite View** - High-resolution satellite imagery for Nigeria
✅ **360° Rotation** - Full compass rotation support
✅ **3D Pitch** - Tilt the map for better terrain visibility
✅ **Toggle Button** - Switch between Satellite ↔ Streets view
✅ **Custom Markers** - Color-coded panic alerts
✅ **Smooth Performance** - Native map rendering