# Security Policy

## Sensitive reports

Do not include API keys, private notes, Vault exports, conversation transcripts, or cognitive-model data in a public issue.

For a security-sensitive report, use GitHub's private security reporting feature when it is available for this repository. If private reporting is unavailable, contact the maintainer through the GitHub profile without attaching private user data.

## Local data

The plugin stores its API configuration in Obsidian-managed plugin data. Users should treat the local `data.json` as sensitive and must never commit it to Git.

Source-note modification or leakage of note content/API credentials in logs should be treated as high-priority security defects.
