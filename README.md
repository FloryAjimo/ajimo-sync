# Ajimo Sync

[Русская инструкция](README.ru.md)

Sync notes and attachments between your Obsidian devices through your own server, with end-to-end encryption.

Ajimo Sync is an experimental plugin. Windows and Android have been tested with a live server. Keep an independent backup of your vault.

## Requirements

- Obsidian 1.8.0 or newer.
- Your own [Ajimo Sync Server](https://github.com/FloryAjimo/ajimo-sync-server), reachable over HTTPS.
- A server API token, a shared Vault ID, and a shared encryption key.

The [server installation guide](https://github.com/FloryAjimo/ajimo-sync-server#deploy-on-a-linux-host) covers Docker Compose, HTTPS and backups. The plugin settings also link to the Russian guide below the Server URL field.

## Installation and updates

Install Ajimo Sync from **Settings > Community plugins > Browse**. Use **Check for updates** to look for a newer version. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same GitHub release into `<vault>/.obsidian/plugins/floryajimo-private-sync/`, then enable the plugin.

When updating an existing installation, keep its `data.json`. The plugin ID remains `floryajimo-private-sync`, including for versions formerly named Private Sync.

## Connect your devices

1. On the first device, enter your server's HTTPS URL, API token, and Vault ID.
2. Generate an encryption key in the plugin settings, then run the connection check and a manual synchronization.
3. On another device, use the same server URL, API token, Vault ID, and encryption key. Keep a different Device ID for each device.
4. Enable automatic synchronization on each device as desired. The change delay defaults to 5 seconds. The periodic check defaults to 10 minutes; 0 disables periodic checks.
5. Automatic synchronization runs while Obsidian is open. Mobile operating systems can suspend it in the background.

On Obsidian 1.13 or newer, the plugin settings are available in settings search. Obsidian 1.8 through 1.12 use a compatible settings page.

Do not generate a new key to connect an existing vault. The server cannot recover a lost key.

## Sync themes and CSS snippets

1. On the device with your preferred theme and snippets, turn on **Sync themes and CSS snippets** in Ajimo Sync and run a manual sync.
2. Turn on the option on each device that should share these files and run a sync there. The option starts disabled on each installation.
3. In Obsidian's **Appearance** settings, select the downloaded theme and reload the CSS snippet list, then enable the snippets you want. Restart Obsidian if the theme list still needs refreshing.

Ajimo Sync transfers `theme.css` and `manifest.json` for each theme and `.css` files directly in the snippets folder. Each device keeps its active theme and snippet selections. A manual, startup, or periodic sync picks up edits to these files even when Obsidian emits no vault file event. Deletions propagate to participating devices and go to the local vault trash. If both devices edit the same file, find the saved local copy in `ajimo-sync-conflicts` in the Obsidian configuration folder.

## Sync custom hotkeys

1. Turn on **Синхронизировать горячие клавиши** (sync hotkeys) in Ajimo Sync on the device with the shortcuts you want and run a sync.
2. Enable the option on each receiving device, sync and restart Obsidian. Each installation opts in separately.

The plugin shares the vault's `hotkeys.json`. If the same file changes on two devices, look for the previous local copy in `ajimo-sync-conflicts` inside the receiving device's configuration folder. Deletions propagate to participating devices and move their files into the local vault trash.

## Compare community plugins

1. Enable **Синхронизировать список плагинов** (sync plugin lists) in Ajimo Sync on each device you want to compare.
2. Run a sync on the device with the plugins you want and then on the receiving device.
3. In Ajimo Sync, open **Недостающие плагины → Показать** (missing plugins → show). Follow a link to the Obsidian Community directory to check the plugin and install it on that device.

On mobile, the list omits plugins marked desktop-only. Private or manually installed plugins may lack a public directory listing. To remove a device's shared list, turn off the option on that device and run a sync.

## Sync settings for selected plugins

1. Install the same plugin on the devices that should share its settings. In Ajimo Sync, open **Настройки выбранных плагинов → Выбрать** (settings for selected plugins → choose). Enable it first on the source device and run a sync.
2. Enable it on the receiving device and sync there. Restart Obsidian to load the received settings.
3. If the file differs on both devices, find the earlier local copy in `ajimo-sync-conflicts/plugins/<plugin-id>` inside the receiving device's configuration folder.

This option shares the entire `data.json` of the chosen plugin, which may contain tokens and machine-specific paths. An absent local file can be restored from the shared copy. You can deselect a plugin to stop further syncing on that device. The last encrypted copy remains on the server.

## Data handling and network access

The plugin sends requests only to the server URL you configure. It does not contact an author-hosted service or send telemetry.

- `GET /health`: checks the server and API token.
- `GET/PUT /v1/vaults/<vault-id>/manifest`: reads or replaces the encrypted file index.
- `GET/PUT /v1/vaults/<vault-id>/objects/<object-id>`: transfers encrypted notes and attachments.

Requests include the server API token in the Authorization header. HTTPS is required except for loopback development servers. The server sees the Vault ID, ciphertext sizes, object identifiers, and request timing. File contents and file paths are encrypted on the device using AES-256-GCM; the encryption key is not sent to the server.

With Obsidian 1.11.5 or later, Ajimo Sync migrates the API token and vault key to the local Obsidian SecretStorage when available. Older versions keep the values in the plugin's local `data.json`. Moving plugin settings to another device may require you to enter the token and key again. The optional Copy key button writes the key to the device clipboard.

The diagnostics dialog shows the installed version, automatic synchronization settings, timestamps, and result counters. You can copy the report to the clipboard. It excludes the server URL, API token, encryption key, Vault/Device identifiers, device name, file paths, and raw error messages. It is never sent automatically.

The plugin reads and changes notes and attachments using Obsidian's Vault API and uses the adapter for optional themes, snippets, hotkeys, and selected plugin settings. Plugin list sharing reads installed plugins' manifests and shares IDs, names, and desktop-only flags inside the encrypted index. Plugin code, enabled states, Ajimo Sync's own settings, workspace layouts, and trash stay local. Conflict copies preserve competing changes. Deletions of notes and attachments use Obsidian's configured trash preference. Keep your own backups. If a device reports an older or incompatible manifest, check the server URL and recover files into a separate test vault before resuming synchronization.

## Source and license

This repository contains the complete TypeScript source of the Obsidian client, production build configuration, public release metadata, and downloadable plugin builds. The compatible server is maintained separately.

Build the client with Node.js 22:

```bash
npm ci
npm run build
```

The production bundle is written to main.js in the repository root. manifest.json and styles.css are distributed alongside it in GitHub Releases. Development and regression tests are maintained in the separate development repository.

MIT License. Copyright 2026 FloryAjimo.
