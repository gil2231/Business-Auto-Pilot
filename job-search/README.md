# NYC Sales / AI / GTM / E-commerce Job Search

Deliverables:
- `NYC_Sales_GTM_Jobs_Master.xlsx` is the main workbook. Its tabs are Summary, Priority Applications, All Verified NYC Jobs, $120K+ OTE, Early-Career Friendly, E-Commerce & Consumer Tech, Unverified Compensation, and Excluded - Closed.
- `NYC_Sales_GTM_Jobs_All.csv` is every active row in one flat file.

Status as of 2026-10-14, 2:50pm ET:
- 139 unique NYC openings are active.
- 117 listings were rejected and logged with a reason: closed or stale, below the $90K target, too senior, not NYC, or a red flag.

How each job was checked: this cloud session could not open job pages directly because of its network policy. Every row was checked through web-search results that index the posting's own text (title, location, pay, requirements). Before applying, re-open the link and confirm the req is live.

## Files
- `data/jobs.jsonl` holds active jobs, one JSON object per line.
- `data/excluded.jsonl` holds rejected listings with reasons.
- `suppression.txt` lists companies already researched. They are auto-excluded unless the row has a `revisit` reason.
- `search_log.md` lists queries and sources searched.
- `build_workbook.py` rebuilds the xlsx and csv: `python3 build_workbook.py`
- `add.py` and `upd.py` are helpers that append and edit rows.

## Scoring
- Tier is set by the midpoint of the advertised range: OTE if one is listed, otherwise base. OTE is never guaranteed, so base is shown separately.
- Overall priority (out of 100) = Fit×3 + Hireability×3 + Comp×2 + Growth×2.
