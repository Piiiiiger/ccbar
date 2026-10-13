---
description: Configure ccbar plugin settings
allowed-tools: Read, Write
---

# Configure ccbar

Edit `~/.claude/plugins/ccbar/config.json`.

Rules:
- If the file does not exist, create it.
- Keep valid JSON formatting.
- Preserve unknown fields already present.
- If the user did not specify exact changes, ask what they want to change before editing.

Default shape:

```json
{
  "rows": [["ctx", "id"], ["5h", "session"], ["7d", "lines"], ["scoped"]],
  "activity": true,
  "columns": null
}
```

Layout items: `ctx` `5h` `7d` `scoped` `id` `session` `lines` `spend` `today` `week` `month` `total` `history`. Put `scoped` and `spend` on a row of their own.
