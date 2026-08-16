# Link Validator Regression Fixture

This file tests the link validator's fenced-code-block handling.

## Case 1: Fake broken link inside a fenced block (must be IGNORED)

```markdown
> This [fake link](totally-nonexistent-file-that-should-never-exist.md) is inside a fenced block
> and should NOT trigger a link error.
```

## Case 2: Valid real link outside a fence (must PASS)

This [valid link](../../README.md) points to the real README.

## Case 3: Broken real link outside a fence (must FAIL)

This [broken link](definitely-does-not-exist-anywhere.md) is outside a fence
and SHOULD trigger a link error.
