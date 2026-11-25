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

### About the password

- You make it up and type it in `APP_PASSWORD`. It exists only in your Vercel project: not in the code, not in the database, and not in anyone else's site.
- Every copy of Charts is separate. Whoever publishes their own site has their own password and their own database.
- There are no user accounts. Everyone who has the password sees and edits the same watchlist and drawings, so do not share it. To let others try the site, use a guest password.
- Each device stays signed in for 180 days. Eight wrong attempts lock that address for 15 minutes.
- Forgot it? Set a new `APP_PASSWORD` in Vercel and redeploy. Your data is kept.

### Guest password (optional)

Add `GUEST_PASSWORD` in Vercel, with at least 12 characters and different from `APP_PASSWORD`, and redeploy. People who sign in with it get a read-only area:

- It shows a fixed sample list and never your data. Guests cannot change anything on the site.
- They can still draw and change indicators, colors and groups. Those stay in their own browser.
- A **Guest** badge shows which area is open, and guests stay signed in for one day.
- Signing in with the guest password never counts as a wrong attempt, so many people can share it. Do not use a password you use elsewhere.
- Web sync does not accept it.

To end guest access, delete the variable and redeploy. Guest use counts toward your Vercel limits, and price requests to Yahoo and Binance come from your site.

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

## Use the same data everywhere

On the computer, open **More > Web sync**, enter the address and password of your site, and click **Connect**. What the site does not have yet is sent to it, and nothing is deleted. If both have the same symbol or drawing, the site's version is kept.

From then on the computer and the site share the watchlist, groups, drawings and indicators. A change on one shows up on the others in a few seconds, while they are open.

- Price history stays on the computer.
- Without a connection, the computer shows the last copy and refuses changes, so the two never drift apart.
- The password is not stored on the computer, only the session. **Disconnect** ends it and keeps the local copy.
- If you change the site password, connect again.

To copy the data just once instead, use **More > Export backup** and **More > Import backup**.

## Try it on your computer

```powershell
$env:APP_PASSWORD = "any long password"; node scripts/web-dev.js
```

It opens on `http://localhost:5190` with a temporary database.

## Privacy

The site is protected by your password, and search engines are asked not to index it. Vercel's free plan is for personal, non-commercial use. See [data sources and limits](../README.md#data-sources-and-limits).
