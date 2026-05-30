# scoreboard-cast

A tiny, zero-dependency web app that snaps a photo of a scoreboard every few
seconds from one device and broadcasts the latest frame to everyone watching.

## How it works

- **`/boss`** — the capture page. Open it on the phone pointed at the
  scoreboard, tap **Start broadcasting**, and it grabs a photo from the rear
  camera and uploads it every 5 seconds. The screen is kept awake while
  broadcasting.
- **`/`** — the viewer page. Anyone who opens the root URL sees the latest
  photo, refreshed automatically every 2 seconds, with a **LIVE** indicator.

The latest image is held in memory in a single long-running Node process, so a
restart costs at most one frame.

### Routes

| Route          | Method | Purpose                                       |
| -------------- | ------ | --------------------------------------------- |
| `/`            | GET    | Viewer page (polls for the latest photo)      |
| `/boss`        | GET    | Capture page (camera, uploads every 5s)       |
| `/upload`      | POST   | Receives a JPEG body, stores the latest photo |
| `/latest.jpg`  | GET    | Serves the latest photo bytes                 |
| `/status`      | GET    | `{ hasImage, lastUpdate }` for polling        |

## Running locally

```bash
npm start
# listens on PORT (default 3000)
#   viewer:  http://localhost:3000/
#   capture: http://localhost:3000/boss
```

Requires Node.js 18+. No dependencies to install.

> **Note:** Browsers only allow camera access over `https://` (or
> `http://localhost`). To use `/boss` from a phone, deploy behind HTTPS
> (e.g. Railway, Render, Fly.io) or use a tunnel like `ngrok`.

## Deploying

Any host that runs a Node process works. The app reads `PORT` from the
environment, so platforms like Railway, Render, and Fly.io work out of the box
with `npm start`.
