# AGENTS.md — docs/

Reserved for postmortems, ROI analyses, and multi-reviewer synthesis docs. NOT user-facing — these are operator references.

## Files

_(none currently)_ — the historical postmortems (`mcp-empty-payload-anomaly*.md`, `skip_providers_review_synthesis.md`) were removed when their subjects were deleted: the `answer` tool and the internal fetch waterfall / `skip_providers` (URL fetching is now delegated to the external [omnifetch](https://github.com/cjangrist/omnifetch) service). `docs/` currently holds only this `AGENTS.md`.

## Conventions

- **Postmortems**: include reproduction steps, root cause (or "still investigating"), workaround, and a link to the relevant code path.
- **ROI / cost analyses**: include the data, the methodology, and the conclusion. Numbers should be reproducible from the raw R2 traces.
- **Synthesis docs**: name them `<feature_or_change>_review_synthesis.md`. Include the list of reviewers + their verdicts + the consensus action list.
- **Don't put user-facing docs here.** README.md is for users; this folder is for engineers debugging an incident.

## Related

- `../AGENTS.md` — repo root
- `../README.md` — user-facing docs
