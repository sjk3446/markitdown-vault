# CLI reference

## Local browser app

```powershell
scripts/start-web.ps1                  # open on 127.0.0.1:8787
scripts/start-web.ps1 -NoBrowser       # server only
scripts/start-web.ps1 -Port 8790       # use another local port
scripts/start-web.ps1 -Vault "C:\Vaults\Documents"
```

The browser and CLI share the same vault and SQLite search index. API keys typed into the browser are attached only to the queued job unless the user clicks **키 저장**. That action stores the selected provider's key in Windows Credential Manager under the current Windows account; **삭제** removes it. Keys are never written to the vault or browser storage.

All commands accept `--vault PATH` before the subcommand. The default is `%USERPROFILE%\MarkItDownVault`; `MARKITDOWN_VAULT` overrides it.

```text
mdvault.ps1 init
mdvault.ps1 status
mdvault.ps1 formats
mdvault.ps1 categories [--json]
mdvault.ps1 convert SOURCE... [--category NAME] [--recursive]
    [--provider none|openai|gemini|claude] [--model NAME] [--llm-prompt TEXT]
    [--ocr] [--plugins]
    [--title TEXT] [--copy-source] [--allow-remote]
    [--allow-network-transcription] [--force] [--json]
mdvault.ps1 list [--category NAME] [--limit N] [--json]
mdvault.ps1 search QUERY [--category NAME] [--limit N] [--json]
mdvault.ps1 get ID_OR_TITLE [--path-only]
mdvault.ps1 move ID NEW_CATEGORY
mdvault.ps1 reindex
```
