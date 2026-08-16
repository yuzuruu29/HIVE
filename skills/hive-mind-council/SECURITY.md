# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :x:                |

## Security Rules for the Repository

To ensure the safety and trust of our users, this repository strictly adheres to the following rules:

1. **No Credential Collection**: The repository must not include code or instructions that collect credentials.
2. **No Hidden Execution Instructions**: All code execution must be transparent and explicitly documented.
3. **No API Key Extraction**: The repository must not include code to extract or exfiltrate API keys.
4. **No Environment Variable Exfiltration**: Exfiltrating environment variables is strictly prohibited.
5. **No Obfuscated Scripts**: All scripts and code must be clearly readable and understandable.
6. **No Background Network Calls**: Unprompted or undocumented background network activity is not allowed.
7. **No Malicious Prompt Injection**: Submitting malicious prompts designed to manipulate LLM behavior is forbidden.
8. **No Instructions that Override User Intent**: The skill must always prioritize and follow user intent.
9. **No Instructions that Disable Validation or Security Checks**: Core security and validation features cannot be disabled by instructions.

## Operational Rules

When operating, the skill must adhere to:

- **Do not print secrets**: Ensure no sensitive information is leaked in logs or console output.
- **Do not modify unrelated files**: Scope changes strictly to the necessary files.
- **Do not run destructive commands unless explicitly requested**: Destructive commands (e.g., `rm -rf`, dropping databases) require explicit user approval.
- **Do not claim tests passed unless actually run**: Validation results must accurately reflect execution.
- **Do not run autonomous loops that bypass user intent or safety limits**: The autonomous loop must remain within safe boundaries and respect stop conditions.

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it privately by opening a security advisory on GitHub or emailing the maintainers directly. Do not disclose the vulnerability publicly until it has been resolved.
