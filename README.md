# Royale Roulette

Real-time multiplayer European roulette. An authoritative Node.js server (Express + Socket.io) owns every bankroll, bet, spin and payout; the browser client renders the table on an HTML5 canvas and synthesises all audio with the Web Audio API.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000. Each browser tab is a separate player, so open a second tab (or share your LAN address) to get the two players needed to start. Set `PORT` to change the port.

## Files

| File | Role |
| --- | --- |
| `server.js` | Lobby, host controls, phase state machine, bet validation, `crypto.randomInt` spins, settlement |
| `public/index.html` | Layout, styles, rules / join / round-summary modals |
| `public/client.js` | Canvas table and wheel, spin animation, hit-testing, chip stacks, audio synth, HUD |

## Round flow

`WAITING_FOR_HOST` → host presses **Start Match** (2+ players) → `BETTING_OPEN` (30 s, ends early when everyone locks in or the host closes bets) → `SPINNING` (server picks the pocket, 7 s animation) → `PAYOUT_SETTLEMENT` (4 s) → `ROUND_CLEANUP` (5 s summary) → back to betting.

Tunables (timers, starting bankroll, seat count, spot limit) live in the `CONFIG` object at the top of `server.js`.
