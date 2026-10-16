# Renovate — mmw-review-system

This repository uses [Renovate](https://github.com/renovatebot/renovate) to keep
its dependencies up-to-date. See [`renovate.json`](../../renovate.json) for the
active configuration.

## What Renovate does here

- Opens PRs for outdated npm dependencies
- Groups related packages (e.g. all `@types/*`, all ESLint packages) into single
  PRs to reduce noise
- Auto-merges **minor** and **patch** upgrades
- Requires **manual review** for **major** upgrades (they may contain breaking
  changes)
- Creates PRs for security advisories under the `security` label

## Cadence

Renovate runs once a week, **Monday before 4am (Asia/Shanghai)**.

## Scope — only this repo

This config is scoped to `mmw-review-system`. **No other repositories in
mmw-devs are automatically upgraded by this configuration.** Each repo opts in
separately:

```text
[other repo]
└── renovate.json  →  { "extends": ["local>mmw-devs/mmw-review-system:renovate-preset"] }
```

When you're ready to enable Renovate on another mmw-devs repository:

1. Install the **Renovate** GitHub App on that repository (or organization-wide
   if you decide to roll it out fully).
2. Either:
   - Copy [`renovate.json`](../../renovate.json) into the new repo, **or**
   - Promote the configuration into a [Renovate preset](https://docs.renovatebot.com/config-presets/)
     and reference it from each repo.

## Pinning the Renovate version

The behaviour described above is shipped by whatever Renovate version is
running in the GitHub App at PR-creation time. If you need strict
reproducibility, consider self-hosting Renovate and pinning the image — the
scope of this repo's config file does not change either way.

## Disabling Renovate temporarily

If a PR from Renovate is undesirable, close it and add the comment
`renovate:disable` — Renovate will then skip that package until you re-enable
it.
