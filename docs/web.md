# Web and iPhone version

The web version runs the same interface on your own private site. It asks for a password, works on phones, and can be added to the iPhone Home Screen as an app. It uses two free accounts:

- **Vercel** hosts the site.
- **Turso** stores your watchlist, groups, drawings and indicator settings.

Prices are not stored. They come from Yahoo Finance and Binance on each request, so intraday history is limited to what they provide.

## 1. Create the database

1. Sign in at [turso.tech](https://turso.tech) and create a database. Any name works. Pick a region near São Paulo, or near the region set in `vercel.json`.
2. Copy the database URL. It starts with `libsql://`.
3. Create a database token with read and write access, and copy it.

Keep both private. Never commit them.

> **Shortcut:** you can skip this step and let Vercel create the database. After step 2, open **Storage** in the Vercel project, create a **Turso Cloud** database and connect it to the project with **Production** checked. Vercel adds both database settings by itself, so you never copy the token. Then redeploy.

## 2. Publish the site

1. Fork this repository, or use your own copy.
2. Sign in at [vercel.com](https://vercel.com) with GitHub, choose **Add New > Project**, and import the repository. Keep the suggested settings.
3. Before deploying, open **Environment Variables** and add:

| Name | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | The database URL |
| `TURSO_AUTH_TOKEN` | The database token |
| `APP_PASSWORD` | A password of your own, with at least 12 characters |

4. Click **Deploy**. The tests run first, and the site is only published if they pass.

Each push to `main` publishes a new version the same way. To change the password, edit `APP_PASSWORD` and redeploy; every device has to sign in again.

## 3. Check it

Open the site, sign in, and go to **More > Connection test**. The database, Yahoo and Binance should all say **ok**. If Yahoo fails, it is refusing the host; change `regions` in `vercel.json` and redeploy.

## 4. Add it to the iPhone

1. Open the site in **Safari** and sign in.
2. Tap **Share**, then **Add to Home Screen**.
3. Open **Charts** from the new icon. You may have to sign in once more.

On the phone:

- **Watchlist** and **Chart** are at the bottom. Tap a symbol to open its chart.
- **Add** searches for a symbol. **Edit** reorders, regroups and removes.
- Drag to scroll and pinch to zoom. Press and hold to show the crosshair.
- **Draw** shows the drawing tools. Drag to draw, then drag the handles to adjust.

## Move your data

On the computer, open **More > Export backup**. On the site, open **More > Import backup** and pick the file. Importing adds to what is there and can be repeated. The two copies are independent after that.

## Try it on your computer

```powershell
$env:APP_PASSWORD = "any long password"; node scripts/web-dev.js
```

It opens on `http://localhost:5190` with a temporary database.

## Privacy

The site is protected by your password, and search engines are asked not to index it. Vercel's free plan is for personal, non-commercial use. See [data sources and limits](../README.md#data-sources-and-limits).
