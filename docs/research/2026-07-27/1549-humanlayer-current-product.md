# What does the current HumanLayer product do?

## Decision To Unblock

Explain the current HumanLayer product in plain language, distinguish it from
the retired human-in-the-loop SDK, and give a practical adoption path based on
first-party sources current on 2026-07-27.

## Short Answer

HumanLayer is a commercial IDE and coordination layer for existing coding
agents, primarily Claude Code and Codex. It groups work into tasks, launches one
or more agent sessions on a selected machine, provisions isolated Git worktrees,
collects research/design/plan artifacts, and gives people a shared interface for
review and comments. It supplies workflow and oversight, not its own foundation
model.

The retired HumanLayer SDK was a different product: middleware that could block
high-stakes agent tool calls pending human approval. The current documentation
does not establish that universal blocking guarantee for the new platform.

## Findings

| Claim | Primary Source | Version / Date | Confidence |
| --- | --- | --- | --- |
| HumanLayer positions the current product as an AI IDE, collaboration platform, and software-factory building blocks. | [Product page](https://www.humanlayer.com/) | Checked 2026-07-27 | High |
| Tasks group agent sessions, artifacts, and worktrees; the UI exposes messages, tool calls, and code changes. | [Product page](https://www.humanlayer.com/) | Checked 2026-07-27 | High |
| Guided work can progress through Questions, Research, Design, Structure, Plan, and Implement checkpoints. | [Product workflow](https://www.humanlayer.com/#do-not-outsource-the-thinking) | Checked 2026-07-27 | High |
| macOS has a desktop app; Linux and Windows can run the CLI daemon and use the browser UI. | [Installation docs](https://docs.humanlayer.com/) and [remote daemon guide](https://docs.humanlayer.com/guide/remote-daemons) | Checked 2026-07-27 | High |
| The daemon runs coding sessions on a user-chosen workstation, VM, or private-network host. | [Remote daemon guide](https://docs.humanlayer.com/guide/remote-daemons) | Checked 2026-07-27 | High |
| Browser control currently lacks workspace configuration editing, an embedded terminal, and path autocomplete. | [Browser app limitations](https://docs.humanlayer.com/guide/remote-daemons#browser-app-limitations) | Checked 2026-07-27 | High |
| Workspace setup can create task branches and one or more Git worktrees, copy local files, and run bootstrap commands. | [Workspace setup](https://docs.humanlayer.com/guide/workspaces) | Checked 2026-07-27 | High |
| Codex is authenticated through the HumanLayer CLI and selected as the session provider. | [Codex setup](https://docs.humanlayer.com/guide/codex) | Checked 2026-07-27 | High |
| The product uses the user's agent subscription or API access rather than adding a HumanLayer token bill. | [Product FAQ](https://www.humanlayer.com/#faq) | Checked 2026-07-27 | High |
| GitHub, Linear, and Jira issues can become HumanLayer tasks; Slack can receive artifact and comment notifications. | [GitHub](https://docs.humanlayer.com/guide/github-integration), [Linear](https://docs.humanlayer.com/guide/linear-integration), [Jira](https://docs.humanlayer.com/guide/jira-integration), and [Slack](https://docs.humanlayer.com/guide/slack-integration) guides | Checked 2026-07-27 | High |
| Current pricing is Starter free for up to 3 members and 200 monthly sessions, Pro at $100/user/month, and custom Enterprise. | [Pricing](https://www.humanlayer.com/#pricing) | Checked 2026-07-27 | High |
| Release 0.144.0 removed alternative CodeLayer providers and made Claude Code the sole harness for Anthropic models. | [Release notes](https://docs.humanlayer.com/release-notes#_0-144-0-july-23-2026) | 0.144.0, 2026-07-23 | High |
| The old approval SDK was removed and superseded; the public repository now says its code is largely deprecated. | [Legacy SDK notice](https://github.com/humanlayer/humanlayer/blob/main/humanlayer.md) and [current README](https://github.com/humanlayer/humanlayer) | Checked 2026-07-27 | High |
| Session/task state is synchronized through the HumanLayer API across local or remote execution and web/desktop/mobile views. | [Product architecture description](https://www.humanlayer.com/) | Checked 2026-07-27 | Medium; marketing-level detail |

## Repository Implications

HumanLayer should be evaluated as an alternative outer workflow and team UI for
coding agents, not as a replacement model and not as proof of strict per-tool
approval. A trial should test worktree safety, the desired Codex/Claude permission
mode, artifact-review ergonomics, and what task/session data reaches HumanLayer's
cloud before any repository-wide adoption.

## Conflicts And Unknowns

- The homepage lists Claude Code, Codex, Copilot, and Fireworks, but current setup
  documentation is materially deeper for Claude Code and Codex. The completeness
  of Copilot and Fireworks support is unverified.
- Old CodeLayer and HumanLayer SDK material remains searchable, but it does not
  describe the rebuilt current product.
- Current docs do not describe a general API that blocks every dangerous tool
  call until a human explicitly approves it.
- Public material does not give sufficiently specific answers about code and
  artifact retention, data residency, encryption design, or model-training use.
  Enterprise is the only plan that explicitly advertises on-prem/private VPC.
- Documentation confirms user-provided hosts for remote daemons; it does not
  clearly establish generally available HumanLayer-hosted compute.
- Claims such as "2-3x faster" are marketing claims without a published
  measurement method and are not treated as verified product behavior.
