# Ajimo Sync

Sync notes and attachments between your Obsidian devices through your own server, with end-to-end encryption.

Ajimo Sync is an experimental plugin. Windows and Android have been tested with a live server. Keep an independent backup of your vault.

## Requirements

- Obsidian 1.8.0 or newer.
- A compatible Private Sync server that you operate, reachable over HTTPS.
- A server API token, a shared Vault ID, and a shared encryption key.

The server implementation is currently in a private repository. It is not provided in this release repository, and a generic WebDAV server is not compatible. At present, installation is intended for users who already have access to the compatible server. Public server distribution is not yet available.

## Installation and updates

This plugin is being prepared for submission to the Obsidian community directory. It is not available in the directory yet.

Until publication, download `main.js`, `manifest.json`, and `styles.css` from the same GitHub release into `<vault>/.obsidian/plugins/floryajimo-private-sync/`, then enable the plugin in Obsidian.

After approval and publication, install Ajimo Sync from **Settings ? Community plugins ? Browse**. Use **Check for updates** to find new releases and install them using the update button. Automatic update checking does not automatically install updates.

When updating an existing installation, keep its `data.json`. The plugin ID remains `floryajimo-private-sync`, including for versions formerly named Private Sync.

## Connect your devices

1. On the first device, enter your server's HTTPS URL, API token, and Vault ID.
2. Generate an encryption key in the plugin settings, then run the connection check and a manual synchronization.
3. On another device, use the same server URL, API token, Vault ID, and encryption key. Keep a different Device ID for each device.
4. Enable automatic synchronization on each device as desired. The change delay defaults to 5 seconds. The periodic check defaults to 10 minutes; 0 disables periodic checks.
5. Automatic synchronization runs while Obsidian is open. Mobile operating systems can suspend it in the background.

Do not generate a new key to connect an existing vault. The server cannot recover a lost key.

## Data handling and network access

The plugin sends requests only to the server URL you configure. It does not contact an author-hosted service or send telemetry.

- `GET /health`: checks the server and API token.
- `GET/PUT /v1/vaults/<vault-id>/manifest`: reads or replaces the encrypted file index.
- `GET/PUT /v1/vaults/<vault-id>/objects/<object-id>`: transfers encrypted notes and attachments.

Requests include the server API token in the Authorization header. HTTPS is required except for loopback development servers. The server sees the Vault ID, ciphertext sizes, object identifiers, and request timing. File contents and file paths are encrypted on the device using AES-256-GCM; the encryption key is not sent to the server.

The API token, encryption key, device settings, and synchronization state are stored locally in the plugin's `data.json`. This file is not itself encrypted. The optional Copy key button writes the key to the device clipboard.

The plugin reads and changes files in the current vault using Obsidian's Vault API. It excludes the Obsidian configuration directory and trash, and does not synchronize plugin installations or settings. Conflict copies preserve competing changes. Deletions propagate between devices; synchronization is not a backup.

## Source and license

This repository contains public release metadata and downloadable plugin builds. The source is maintained separately and can be made available to the official Obsidian Community directory GitHub App for source review and build verification.

MIT License. Copyright 2026 FloryAjimo.
