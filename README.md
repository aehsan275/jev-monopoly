# JEV Monopoly

A local Waterloo themed Monopoly game with rule driven play and optional live JEV decisions. The web app listens on `127.0.0.1:5173`; it is not deployed from this repository.

## Setup on Windows

1. Install Node.js 22.13 or newer and clone this repository.
2. In PowerShell, open the cloned repository directory and run `npm ci`.
3. Copy `.env.example` to `.env`. Set `JEV_DEFAULT_API_KEY` to your own key for live JEV decisions. To use owner unlock, also set `OWNER_ACCESS_CODE_HASH` to the SHA-256 hex digest of your owner code and `OWNER_SESSION_SECRET` to a random 32-byte hex string.
4. Run `npm run build`, then `npm run setup:db` to initialize local replay storage.
5. Run `npm run dev` and open [http://localhost:5173](http://localhost:5173).

To generate the owner hash without putting the code in your shell history, run:

```powershell
$ownerCode = Read-Host "Owner code"
[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ownerCode))).ToLowerInvariant()
```

Generate a session secret with:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

The `.env` file, local database, and build output are ignored by Git. The app works without a JEV key using its built-in local policy; live JEV mode makes requests to the external JEV service.

## Checks

Run `npm run lint`, `npm run test:rules`, and `npm run build`. For a built local preview, run `npm run start` after building and initializing the database; Wrangler prints its loopback URL.
