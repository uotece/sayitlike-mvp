# SayItLike MVP

A super simple working MVP of SayItLike: a browser-based multiplayer voice acting party game.

## What works

- Main menu + Play menu
- Quick Battle matchmaking
- Custom rooms with room code/link
- Up to 10 players per room
- Host starts the round
- Same line + same acting style for everyone
- Browser microphone recording
- 10-second max voice clips
- 60-second recording phase
- Anonymous playback
- Voting for best performance
- Results reveal with names + vote counts
- Play Again in the same room
- UI sounds + volume slider

## What is intentionally not built yet

- Accounts/login
- Real leaderboard persistence
- Donations/payment integration
- Public moderation
- Database storage
- Deployment config
- Mobile app

Everything is stored in server memory. If the server restarts, rooms disappear. That is intentional for the MVP.

## Run locally

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

To test multiplayer locally, open the site in multiple browser tabs or different browsers.

## Deployment note

This uses WebSockets through Socket.IO. Deploy it on a service that supports long-running Node servers/websockets, such as Render, Railway, Fly.io, or a VPS. Do not deploy this exact server to static hosting only.


## Account MVP notes

This version includes simple username/password accounts using server-side password hashing.
Accounts are stored in `data/users.json`.

For local testing this is fine. On Render, use a persistent disk for `data/` if you want accounts and leaderboard stats to survive restarts/redeploys.
