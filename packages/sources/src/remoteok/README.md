# RemoteOK adapter

Source: `https://remoteok.com/api` (public JSON, no key). One request returns the ~100 most recent jobs, delayed 24 h; no pagination or filters.
`minIntervalMinutes` is 240.

## Attribution (required by RemoteOK's API terms)

- Link back to the job URL on Remote OK (with follow, no `nofollow`) and name **Remote OK** as the source, or API access may be suspended.
  The digest shows the source name and the posting link, which is how we satisfy this.
- Do not use the Remote OK logo (registered trademark); the name is fine.

## Notes

- The first array element is the legal notice (`{ last_updated, legal }`); the adapter skips it explicitly.
- `salary_min` / `salary_max` carry no currency or period: mapped as USD per year. `0` means no salary.
- Fixture `test/fixtures/remoteok/api.json` was recorded with
  `curl -s -A "job-agent/0.1 (+https://github.com/<owner>/job-agent)" https://remoteok.com/api`, trimmed to 20 jobs.
