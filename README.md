# Sonic 1 AI Playground

Mobile-friendly Sonic 1 browser emulator shell with Sonic Cognition v3 and the bounded failure log.

## Run

Serve this folder over HTTP (recommended):

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`, choose your legally obtained Sonic 1 ROM, and the page loads it with EmulatorJS / Genesis Plus GX.

The page intentionally does **not** include the copyrighted Sonic 1 ROM.

## AI bridge

The page tries to call the libretro exports `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)` and `retro_get_memory_size` through the EmulatorJS core module. If those exports are available, it creates a 64 KB view of Genesis system RAM and feeds the real Sonic RAM state to Cognition v3.

The browser bridge then sends only controller inputs with EmulatorJS `simulateInput`. It does not write Sonic's position, rings, lives, HP, boss HP, object routines, checkpoints, or level completion.

If the core does not expose system RAM, normal play still works and AI Play remains disabled rather than pretending it has game-state access.

## Included AI

- `sonic-cognition-v3.js` — curiosity/world-model/episodic learning agent
- `sonic-ai-failure-log.js` — bounded diagnostic history
- `sonic-cognition-v3-adapter.js` — mailbox contract for a cognition-patched ROM
- `sonic-ai-debug-panel.js` — optional generic debug widget

Memory and learning are stored locally in the browser using localStorage.


## Bundled private test ROM

This build contains the ROM supplied by the user in this conversation:
`Sonic The Hedgehog (USA, Europe).gen`

MD5: `1bc674be034e43c96b86487ac69d9293`

The page auto-loads it as `sonic1.gen`. The ROM picker remains available as a fallback.
The Cognition v3 RAM adapter uses the Sonic 1 RAM map; this exact revision still needs live gameplay validation before claiming full AI compatibility.
