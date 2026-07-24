# FBS Season Board

Project every win and loss across FBS football and watch team records and
conference standings recalculate as you go.

The site is a single HTML file with no build step and no server. Schedule data
lives in `data/` as plain JSON, refreshed on a schedule by a GitHub Action. No
API key is involved at page-load time, so visitors need nothing to use it.

## What's here

```
index.html                          the whole app
data/manifest.json                  which seasons are available
data/season-YYYY.json               teams, games, championship games
scripts/fetch-season.mjs            regenerates the data files
.github/workflows/refresh-data.yml  runs the script weekly
```

## First-time setup

**1. Get a free CFBD key** at <https://collegefootballdata.com/key>. It arrives by email.

**2. Generate the data files.** From the project folder:

```bash
CFBD_KEY=your_key_here node scripts/fetch-season.mjs 2024 2025 2026
```

Requires Node 18 or newer. This writes `data/season-2024.json`,
`data/season-2025.json`, `data/season-2026.json`, and `data/manifest.json`.

Past seasons are worth keeping. They're complete, with real scores, which makes
them the fixtures for checking that tiebreaker logic produces the title-game
matchups that actually happened.

**3. Preview it locally.** Opening `index.html` by double-clicking won't work —
browsers block `fetch` on `file://` URLs. Serve it instead:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

## Publishing to GitHub Pages

1. Push this folder to a public GitHub repository, `data/` included.
2. In the repo, go to **Settings → Pages**, set Source to **Deploy from a
   branch**, pick `main` and `/ (root)`, and save.
3. The site goes live at `https://YOURNAME.github.io/REPO/` within a minute or so.

### Keeping it current during the season

1. Go to **Settings → Secrets and variables → Actions → New repository secret**.
2. Name it `CFBD_KEY` and paste your key. It's encrypted, and it never appears
   in the repository or in workflow logs.
3. The workflow then runs every Tuesday morning UTC and commits any changed
   scores. You can also trigger it by hand from the **Actions** tab.

Two things to know about scheduled Actions: GitHub pauses them in repositories
with no activity for 60 days, so a nudge is needed if you go quiet over the
offseason, and scheduled runs can lag their stated time when GitHub is busy.

## Using the board

Click either team in a matchup to project the winner; click again to clear it.
Completed games fill in from real scores and can't be overridden. Picks save to
your browser automatically and can be exported to a JSON file, which is the way
to keep several scenarios side by side or share one with someone else.

## Notes on the data model

Conference records only count games where CFBD flags the matchup as a conference
game **and** both teams are FBS members of that same conference for that season.
Checking membership rather than trusting the flag alone matters in realignment
years, which is most of them lately.

Standings sort on conference win *percentage*, not raw wins, because conference
schedules aren't uniform — the ACC in 2026 has twelve teams playing nine league
games and five playing eight. Teams level on percentage may therefore show
different win-loss records, and the tie flag lists each team's own record.

## Tiebreakers

`tiebreakers.js` implements the published championship-game procedure for nine
conferences; `context.js` turns a season plus your picks into what it consumes.
Each step that can be derived from wins and losses is applied in the order the
conference specifies, and any separation restarts the procedure for the
resulting groups, as the documents require.

Steps that need something a projection cannot supply — CFP rankings, SportSource
Analytics ratings, scoring margins, coin tosses — stop the engine, which then
reports what it would need. Naming the participants and seeding them are treated
as separate questions: two teams level for the last two places both play, and
only the host is left open.

The Pac-12 is not implemented. It may rewrite its final week of conference
matchups based on the standings, so those games are flagged as provisional in
the schedule rather than treated as fixed.

### Validation

    node test-sec-examples.js              # 20 unit tests, including the SEC's own examples
    node scripts/validate.mjs 2024 2025    # replay finished seasons against real title games

The replay is the meaningful one. It reproduces 14 of the 18 championship
matchups from 2024 and 2025 exactly; the other four stop at a CFP ranking or an
analytics rating, with the teams that actually played still in contention.

Data from [CollegeFootballData.com](https://collegefootballdata.com).
