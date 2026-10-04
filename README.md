# Royale Roulette

Real-time multiplayer European roulette. An authoritative Node.js server (Express + Socket.io) owns every bankroll, bet, spin and payout; the browser client renders the table on an HTML5 canvas and synthesises all audio with the Web Audio API.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000. Set `PORT` to change the port.

Friends on the same Wi-Fi join at `http://<your-laptop-IP>:3000` (find the IP with `ipconfig`). Every network address gets one seat; browser tabs on `localhost` are exempt, so you can still test with several tabs on one laptop.

## Files

| File | Role |
| --- | --- |
| `server.js` | Lobby, host/admin rules, phase state machine, bet validation, `crypto.randomInt` spins, settlement, moderation |
| `public/index.html` | Layout, styles, rules / join / round-summary modals, admin panel |
| `public/client.js` | Canvas table and wheel, spin animation, hit-testing, chip stacks, audio synth, HUD, seat menus |

## Round flow

`WAITING_FOR_HOST` → host presses **Start Match** (2+ players) → `BETTING_OPEN` (20 s, ends early when every player with money locks in, or the host closes bets) → `SPINNING` (7 s) → `PAYOUT_SETTLEMENT` (4 s) → `ROUND_CLEANUP` (5 s summary) → back to betting.

## House rules

- **Minimum bet:** a player's total stake each round must be at least $5 (or their whole bankroll if they have less). A smaller stake is refunded and doesn't count.
- **Strikes:** every round below the minimum is a strike. 5 strikes in a match, or 3 in a row, freezes the player's bankroll at $0 until the admin restores it. Players at $0 are never waited for.
- **Reconnects:** a dropped player keeps their seat for 10 seconds.
- **Rejoining:** a network that left (or was removed) needs the admin's approval to rejoin for 10 minutes, and comes back with the balance it left with.
- **Vote-kick:** click a player's badge. Needs more than half of the other players and at least 2 votes (so 3+ players); votes expire after 60 s.

## Host vs admin

The first player seated hosts, and anyone connecting from `localhost` always takes over hosting. **Only a host on localhost is the admin** (gold crown). The admin can remove players, approve or deny rejoin requests from the bell menu, restore frozen bankrolls and restart the game. A host on any other machine (silver crown) can only start the match and close bets.

Admin detection uses the real TCP connection, and any proxy or tunnel header disqualifies it. A visitor can't fake being localhost, but it also means **nobody is admin on a hosted deployment such as Render**. Run the server on your own machine to have admin powers.

Tunables (timers, limits, starting bankroll, seat count) live in the `CONFIG` object at the top of `server.js`.
