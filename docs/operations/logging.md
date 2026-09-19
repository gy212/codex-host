# Runtime logs

The Host writes one JSON object per diagnostic line to:

```text
%USERPROFILE%\.codexhost\logs\host-runtime.jsonl
```

Set `CODEXHOST_DATA_DIR` to move all codexhost data, or `CODEXHOST_LOG_DIR` to move only logs.
Each entry includes a timestamp, severity, event name, process ID, message, and any stable Thread or
Turn identifiers available at the failure site. Secret-looking fields and bearer credentials are
redacted; prompt text, tool input/output, and environment values are not logged.

Follow the log in PowerShell:

```powershell
Get-Content "$env:USERPROFILE\.codexhost\logs\host-runtime.jsonl" -Wait
```
