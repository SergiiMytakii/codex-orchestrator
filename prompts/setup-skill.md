# Codex Orchestrator Setup

Use this prompt to help a maintainer install `codex-orchestrator` in a repository.

1. Confirm the GitHub owner, repository name, and target repository path.
2. Run `codex-orchestrator setup --target <path> --github-owner <owner> --github-repo <repo> --dry-run`.
3. Review the generated config plan, label report, workflow sources, and checks.
4. Run setup without `--dry-run` only after the maintainer agrees.
5. Use `--prepare-labels` only when the maintainer wants missing GitHub labels created.
6. Do not launch Codex implementation from setup.
7. Do not commit, push, or open a pull request from setup.
