# Deploys

Production (aeo.campaigncreators.com) deploys from `main` through the Vercel Git
integration on project `campaign-creators-aeo-auditor`. Every PR branch gets a
preview.

## If a merge doesn't reach production

From 2026-07-16 to 2026-09-25 no push built on Vercel. The repo moved from
`frainkanderson23` to the `Campaign-Creators` org, and the project's Git link
still pointed at the old owner, which had no Vercel GitHub App. Fixed on
2026-09-25 by installing the app on the org and reconnecting the repo in
Vercel → Settings → Git.

Check after every merge:

- The `main` commit on GitHub shows a **Vercel** status.
- The production deployment's commit SHA matches `main` HEAD.

## Previews use production data

Preview deployments get the same Supabase project and HubSpot token as
production. Don't submit the audit or unlock forms on a preview.
