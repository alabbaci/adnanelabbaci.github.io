# Tunis Heat Twin

An interactive app version of the DTT4SD hands-on notebook
[brunocalet/DTT4SD-Tunis-UHI](https://github.com/brunocalet/DTT4SD-Tunis-UHI)
by Bruno Ćaleta (Oikon): the urban heat island of Tunis as a digital model,
a digital shadow and a digital twin.

**▶ App: [`index.html`](index.html)** (served by GitHub Pages at `/tunis-uhi/`).

| Step | What the app shows |
|---|---|
| Observe | Landsat 8 land surface temperature on 2 August 2021, true colour, land cover |
| Digital model | A 100-tree Random Forest that predicts temperature from 8 land-cover shares (R² 0.62 on unseen cells) |
| Digital shadow | The same model applied to the newest clear overpass in the archive (24 December 2021) |
| Digital twin | Outline an area, add trees, and the forest re-predicts the temperature in the browser |

## How it differs from the notebook

The notebook needs a Google Earth Engine project. This build does not:

- **Temperature:** Landsat 8 Collection 1 Level-1 band 10 from the Google Cloud
  public archive, converted with an NDVI-threshold emissivity. There is no
  atmospheric correction, so absolute values run a little cooler than the
  Level-2 product the notebook uses.
- **Land cover:** share of each ESA WorldCover 2021 class inside a 90 m cell,
  where the notebook uses Dynamic World class probabilities.
- **Dates:** the public archive ends in 2021, so the model day is 2 August 2021
  (not 20 July 2025) and the "newest overpass" is fixed, not live.

## Rebuild

```bash
pip install rasterio numpy scikit-learn pillow
python pipeline/build_data.py   # downloads the windows it needs, writes data.js (~3 MB)
python pipeline/build_page.py   # wraps src/page.html into index.html
python -m http.server           # then open http://localhost:8000
```

## Credits

Method, text and stage structure: DTT4SD workshop, Tunis, 10 November 2026,
Bruno Ćaleta, Oikon Ltd. (text and figures CC BY 4.0, code MIT). Landsat data
courtesy of the U.S. Geological Survey. © ESA WorldCover project 2021
(CC BY 4.0).
