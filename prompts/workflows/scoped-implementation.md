# Scoped Implementation Workflow Fallback

Implement one scoped issue from GitHub context and repository instructions.
Use tests where possible and report validation, skipped checks, and risks.
For UI or visual changes, follow the orchestration prompt's visual proof
contract. If a runner-owned visual proof command is configured, prepare its
script/artifacts but let the runner execute it. Otherwise use BrowserUse/browser
when it is available, verify the changed screen in a browser, and attach
screenshot artifacts.
