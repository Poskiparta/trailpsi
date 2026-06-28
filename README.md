# TrailPSI

Route-aware tire pressure calculator with GPX upload.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Add an openrouteservice API key:

```bash
cp .env.example .env.local
```

Edit `.env.local` and set:

```bash
ORS_API_KEY=...
```

3. Start the app and local API server:

```bash
npm run dev
```

Open the Vite URL shown in Terminal.

## GPX surface analysis

TrailPSI sends the GPX to `/api/analyze-gpx`, which calls openrouteservice directions with `extra_info=surface`. The backend samples the GPX into route points, asks openrouteservice to route through those points, and summarizes the returned surface distances.

This is not pure map matching, but it is more robust than the old browser-only Overpass/nearby-way heuristic and does not require GraphHopper Map Matching access.

Without `ORS_API_KEY`, distance and elevation still work locally, but surface analysis will show a configuration error.
