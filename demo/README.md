# Demo

NWS watches and warnings on Google Maps, rendered by nullisland from the public
[`NWS_Watches_Warnings_v1`](https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/NWS_Watches_Warnings_v1/FeatureServer)
FeatureServer.

## Run

```bash
npx serve demo
# or
python3 -m http.server 8080 --directory demo
```

Then open the printed URL (`http://localhost:3000` for `serve`, `http://localhost:8080` for Python).

## Why a Google Maps key?

Google's JavaScript API requires a key. There is no keyless way to get a `google.maps.Map` that can
host overlays — the keyless `output=embed` iframe cannot. The demo therefore asks for a key at
runtime, keeps it in `sessionStorage` (and `localStorage` if "remember" is checked), and never
commits one.

Create a key in a Google Cloud project with **Maps JavaScript API** enabled, then restrict it to
your HTTP referrers (`http://localhost:8080/*`, your hosting domain).

## Data

The service is public, CORS-enabled and serves PBF, so no ArcGIS token is involved. The demo uses
three of its sublayers:

| Layer | URL suffix | Colour |
| --- | --- | --- |
| Severe | `/9` | orange |
| Moderate | `/10` | amber |
| Minor | `/11` | blue |

## Hosting

Any static host works. For GitHub Pages: Settings → Pages → Source: **GitHub Actions**, then deploy
the `demo/` folder. The page imports `demo/nullisland.js`, a browser bundle of `src/` produced by `npm run build:demo`.
Rebuild it after changing the library.
