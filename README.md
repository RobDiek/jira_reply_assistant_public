# Jira Reply Assistant (Public)

An AI-powered browser extension that helps generate context-aware Jira ticket responses. It analyzes ticket content (summary, description, comments) and provides intelligent suggestions and ready-to-send replies for both technical agents and end users.

## Features
- Smart ticket analysis and categorization (VPN, SSO/MFA, Mail, Storage, Printing, Generic)
- Personalized user-mode responses (flowing text, "Hello [Name]" greeting, "Best regards" closing)
- Technical agent-mode responses (concise, structured, internal-use)
- Dynamic action suggestions
- Free-text prompt input with full ticket context
- Works on *.atlassian.net and generic /browse/* Jira paths

## Privacy & Security
- No company-specific URLs or secrets included
- API key stored via Chrome storage; not bundled in source
- Works with OpenAI API or compatible endpoints (Azure OpenAI, local LLMs)

## Quick Start
1. Clone this repo
2. Load extension as unpacked in Chrome/Edge
3. Configure API settings in Options (API key, base URL, model)
4. Open any Jira issue → Use the floating "J" button

## Configuration
- API Base URL: defaults to https://api.openai.com
- Endpoint auto-detection: appends /v1/chat/completions when needed
- Model: defaults to gpt-4o-mini (customizable)

## Development
- Manifest V3
- background.js (service worker), contentScript.js (page logic), options.html/js (config)

## License
MIT (or your preferred license)

## Disclaimer
This is a generic, sanitized version suitable for public use. You are responsible for your own API keys, endpoints, and compliance with your organization’s policies.
