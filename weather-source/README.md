# Africa Weather Explorer deployment

The browser app is in `../weather/`; the existing Dakhla homepage is unchanged.

Run `uv sync --python 3.12 --frozen`, then `uv run python -m sweep --no-ai --out ../weather/data` from this directory to regenerate the forecast. Exit 3 means the latest run is already included.

The Africa workflow (`.github/workflows/africa-weather.yml`) is the site's only publisher: it deploys the entire existing static website plus `/weather/` from `main` at 08:20 and 20:20 UTC, on every push to `main`, after each Morocco energy forecast run, and on manual runs. It does not commit runtime forecast assets back to Git. If a forecast refresh fails, the site is still deployed with the forecast data committed on `main` and the run carries a warning.

The workflow deploys through the `github-pages` environment, which only accepts runs from branches on its allowed list. Scheduled runs and the post-energy-forecast runs execute on the repository's default branch, so that branch must be allowed (simplest: make `main` the default branch).

## GitHub Pages and Namecheap

1. Merge these changes into the repository's default branch (currently `claude/dakhla-heat-mapping-eti6k0`).
2. In repository Settings > Pages, set Source to GitHub Actions.
3. Set Custom domain to `minirabattraffic.world` and save before changing DNS.
4. In Namecheap > Domain List > Manage > Advanced DNS, if the domain uses Namecheap DNS, configure four A records for host `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. Set TTL to Automatic. Replace only conflicting web records for the same host; retain email and verification records.
5. Configure CNAME host `www` to `alabbaci.github.io` (the GitHub username, not the repository name).
6. Run the Africa Weather Explorer workflow and enable Enforce HTTPS once GitHub's certificate is ready. DNS and certificate issuance may take up to 24 hours.

If Namecheap's Nameservers section shows Custom DNS, make the DNS changes at that nameserver provider instead.

Expected address after activation: https://minirabattraffic.world/weather/

References: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
