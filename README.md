# updated website

## Berkeley tennis availability

The homepage's Useful Links section links to `/tennis/`. This static page shows today, tomorrow,
and the following day in `America/Los_Angeles`. All three days are stacked vertically,
each with time down the rows and parks across the columns. Blue blocks link directly
to CivicRec's booking page; the user selects the park and time there. Court numbers
are shown inside each available window. Intervals with no availability across any
park collapse into a single compact row. A map below marks all eight parks and
UC Berkeley (Sather Tower), using OpenStreetMap coordinates and Leaflet 1.9.4.
The map loads when it approaches the viewport; location links remain available
if the external map library or tiles cannot load.
It covers the Berkeley municipal tennis reservation catalog, not every nearby city.

`.github/workflows/tennis-availability.yml` fetches all courts at minute 17:

- Every hour from 09:17 through 23:17 Pacific.
- At 00:17, 03:17, and 06:17 Pacific overnight.
- The timezone-aware schedules follow daylight saving time automatically.

After these changes are pushed to `master`, the workflow runs once and creates the
`tennis-data` branch containing `availability.json`. Subsequent successful runs
update that branch; the page reads the public snapshot directly from
`raw.githubusercontent.com`, which supports browser cross-origin reads. This avoids
rebuilding Pages for every data update and requires no backend or additional secrets.
The workflow uses the built-in token with `contents: write`; repository or organization
policies must allow it to write the data branch. Existing Pages publishing settings
can stay as they are. Use **Actions → Update tennis availability → Run workflow**
for a manual refresh.

The checked-in `assets/tennis-initial.json` is a real initial snapshot and a fallback,
not an automatically updated local copy. The browser keeps the newest valid snapshot
in local storage and marks old data. A failed or incomplete upstream query does not
overwrite the published snapshot. Missing dates are shown as awaiting an update,
rather than being labeled as having no openings. Reloading the page or the snapshot
does not trigger a new CivicRec query; bookings and final availability are on CivicRec.

GitHub schedules can be delayed, and public-repository schedules can be disabled
after 60 days without repository activity. Monitor Actions if updates stop; see
[GitHub's scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Local commands (Python 3.9+ and Node 18+, no third-party dependencies):

```sh
python3 scripts/berkeley_tennis.py --days 3
python3 scripts/berkeley_tennis.py --park 'live oak' --after 17
python3 scripts/berkeley_tennis.py --output /tmp/availability.json
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/tennis.test.cjs
```

The scraper, tests, and workflow are excluded from the Jekyll site output.
The map's park addresses can be checked against the
[City's court directory](https://berkeleyca.gov/community-recreation/parks-recreation/facilities/sports-fields-and-courts).
OpenStreetMap geometry references are recorded in `assets/tennis-locations.json`;
the page includes attribution and the required tile caching is left to the browser.

This repo is built on a fork of **Jekyll Now** from [this repository](https://github.com/barryclark/jekyll-now). **Jekyll** is a static site generator that's perfect for GitHub hosted blogs ([Jekyll Repository](https://github.com/jekyll/jekyll))

The website design is just a modification of [Jon Barron's website](https://jonbarron.info/) and is converted for my own use, re-purposing my old markdown posts. **Feel free to use template for your own purposes**, but please respect copyright for all the images/content in my `images`, `pdfs`, `_posts` folders. 



## issues
* In general, jekyll will try to build a full page for every post. I skip that by forcing `permalink: /`. This creates multiple entries in sitemap.xml for index.html but is otherwise fine. 
* If you want multiple paragraphs, consider using `excerpt_separator: <!--more-->` in `_config.yml`, for my own use I didn't need this. 
* My own posts have lots of extra stuff left over from my old jekyll design ("author", long descriptions, etc.), feel free to ignore them
* I use thumbnails, so I can upload arbitrary sized images but then only display small ones. The `_make_thumbnails.sh` script generates them and the html template looks in `tn/` for all images. 
* I have three categories of post with slightly differerent formatting, so changing sizing requires edits in multiple paces. 
