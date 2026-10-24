# RECO MTF Lens Analyzer Tool

India's margin trading (MTF) book, rebuilt every trading day from NSE's public disclosures, with a plain-English insight on every chart.

Dashboards: Overview, Flows, Composition, Leverage & risk, Stocks, Smart money?, Stock explorer.

## How it works

- `pipeline/fetch.py` downloads NSE's daily margin trading file, full bhavcopy, index closes and monthly market-cap file, and stores one compact file per day in `data/days/`.
- `pipeline/build.py` turns that history into the JSON the site reads, including the insight text, and writes the finished site to `dist/`.
- `.github/workflows/update.yml` runs both every weekday evening and morning, commits any new days, and deploys to GitHub Pages.

## Run locally

```
pip install -r requirements.txt
python pipeline/fetch.py --days 20
python pipeline/build.py
python -m http.server 8000 --directory dist
```

Data: NSE India. Not investment advice.
