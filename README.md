<div align="center">
  <h1>OpenCodra</h1>

  <p>
    Self-hosted AI code review for GitHub and Bitbucket pull requests.<br/>
    Cloudflare-native, queue-backed, repository-aware, and built for teams that want to own their review engine.
  </p>

  <p>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <a href="https://workers.cloudflare.com/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020?logo=cloudflare"></a>
    <a href="https://react.dev/"><img alt="Built with React" src="https://img.shields.io/badge/dashboard-React-61dafb?logo=react&logoColor=111"></a>
    <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=fff"></a>
  </p>

  <p>
    <a href="https://github.com/michnicki/opencodra/issues">Issues</a>
    |
    <a href="CONTRIBUTING.md">Contributing</a>
    |
    <a href="LICENSE">License</a>
  </p>
</div>

![OpenCodra — AI code review on every PR](./public/assets/opencodra-landing.png)

OpenCodra listens to GitHub and Bitbucket pull request events, runs AI-powered review jobs, posts inline findings back to the PR, and gives you a dashboard to inspect jobs, repositories, model routing, review history, and failed queue runs.

> **OpenCodra is a fork of [Codra](https://github.com/devarshishimpi/codra) by Devarshi Shimpi.** It exists for one reason: the original Codra requires a **Contributor License Agreement (CLA)** to accept contributions. OpenCodra removes that requirement — contributions are accepted under AGPL-3.0 with **no CLA**. Same license, original copyright retained; this fork adds Bitbucket support, removes the upstream anonymous usage telemetry, and welcomes open contributions.

<!-- QA-IDX-01 UAT: GitHub post-merge incremental refresh verification, 2026-07-30 -->


> **Beta** - OpenCodra is under active development. Expect rough edges, missing features, and breaking changes between releases. Feedback and bug reports are welcome via [GitHub Issues](https://github.com/michnicki/opencodra/issues).

## Why OpenCodra

- **No CLA to contribute**: OpenCodra accepts contributions under AGPL-3.0 with no Contributor License Agreement — the barrier that motivated this fork.
- **No telemetry, no phone-home**: Upstream Codra ships anonymous usage telemetry that reports review metrics to a hosted endpoint by default. OpenCodra removes it entirely — nothing is collected or sent.
- **Own the whole review loop**: Run the GitHub/Bitbucket app, Cloudflare Worker, queue, database, model credentials, and dashboard under your own control.
- **Review with repository context**: OpenCodra checks pull request diffs for correctness, security, performance, maintainability, and repo-specific patterns.
- **Configure each repository**: Tune triggers, skipped paths, draft handling, mention reviews, labels, custom rules, and review budgets from the dashboard.
- **Route models deliberately**: Use global defaults, per-repo model chains, fallbacks, and size-based overrides for larger pull requests.
- **Operate the system**: Inspect job history, PR findings, webhook deliveries, model usage, and dashboard stats.

## Features

- Automatic reviews on `opened`, `synchronize`, `ready_for_review`, and `reopened` pull request events (GitHub and Bitbucket)
- Mention-triggered reviews for on-demand analysis
- Inline PR review comments, summary reviews, and status updates (GitHub check runs / Bitbucket Code Insights)
- Queue-backed processing through Cloudflare Queues
- GitHub and Bitbucket OAuth dashboard authentication
- External PostgreSQL storage through Cloudflare Hyperdrive
- Dashboard-managed LLM providers for OpenAI, OpenRouter, Anthropic, Google, and Cloudflare models
- Repository settings for labels, skipped globs, custom rules, and model routing

## How It Works

1. GitHub or Bitbucket sends OpenCodra a pull request webhook.
2. OpenCodra verifies the signature and loads repository review settings.
3. A review job is stored in PostgreSQL and queued on Cloudflare Queues.
4. The Worker consumes the job, fetches the PR diff, runs model review passes, and formats findings.
5. OpenCodra posts inline comments and a summary review back to the pull request.
6. The dashboard keeps the job history, findings, logs, and stats available for operators.

## Stack

- **Worker**: Cloudflare Workers, Hono, Wrangler
- **Dashboard**: React, Vite, Tailwind CSS, Radix UI, Recharts
- **Data**: PostgreSQL, Cloudflare Hyperdrive, Cloudflare KV
- **Queues**: Cloudflare Queues and Workflows
- **Models**: OpenAI, OpenRouter, Anthropic, Google, and Cloudflare providers
- **VCS**: GitHub App and Bitbucket Cloud webhooks, checks/Code Insights, reviews, and OAuth
- **Quality**: TypeScript, Zod, Vitest, Playwright browser tests

## Telemetry

**OpenCodra sends no telemetry.** Upstream Codra ships anonymous usage telemetry that is *on by default*: it reports aggregate review metrics (token usage, model names, file extensions, finding counts, durations, verdicts) plus a stable anonymous instance ID to a hosted endpoint (`codra.run`), with an opt-out via `TELEMETRY_DISABLED`. OpenCodra removes that code path entirely — there is no instance ID, no usage events, and no network calls home, so there is nothing to opt out of.

## Documentation

Setup and operations notes live in this repository:

- [Webhook subscriptions for bot commands and PR Q&A](docs/webhook-subscriptions.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Contributing

Contributions are welcome — **no Contributor License Agreement required**. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

OpenCodra is licensed under the [GNU Affero General Public License v3.0](LICENSE). It is a fork of [Codra](https://github.com/devarshishimpi/codra) by Devarshi Shimpi; the original copyright is retained as required by the license.

<!-- QA-IDX-01 UAT: GitHub push-event subscription enabled, incremental refresh verification, 2026-07-30 -->
