# AG Live Voting Tool — Project Plan

**Owner:** Nikita Slepcov (IT volunteer)
**Requested by:** President, EPFL Rocket Team (Slack, #channel)
**Reviewer for feasibility:** Jordan Warne, Head of IT — Autumn 2026
**Deadline:** Before rentrée — General Assembly on **8 September 2026**
**Plan written:** 25 August 2026 (14 days of runway, including the AG day itself)

## 1. The ask, in plain terms

The team currently runs AG votes on free online voting sites, but those tools cap the number of questions that can be asked. The President wants a custom tool that:

- displays whatever questions the team wants, with no artificial limit
- collects votes from two audiences at once: people physically in the room, and people joining online
- exports a PDF of the results at the end
- can be as simple as an HTML page — the President explicitly left the implementation up to IT

This is a real, recurring need (AGs happen more than once a year), so it's worth building properly rather than as a one-off hack.

## 2. Requirements

### Functional
- An **admin/presenter view**: create a list of questions live during the AG (no code changes needed — confirmed as a hard requirement since the exact questions aren't known in advance), open one at a time, watch participation come in, close it, move to the next. — **Built.**
- Each question is either **standard** (fixed "Oui / Non / Blanc" — the team's default) or **custom** (admin types an arbitrary list of options, e.g. choosing between dates). — **Built.**
- A **voter view**: reachable by a link or QR code, works on a phone browser with no app install, shows the currently open question, lets someone vote once per question, can change their vote while it's still open. — Next up.
- **Live simultaneous voting**: in-person and online participants vote on the same question at the same time — confirmed everyone votes through the same site regardless of location, no separate in-room mechanism needed. — **Built.**
- **Results stay hidden while voting is open**: the President was explicit that the room should only ever see the *final* result once a vote closes, not a live-updating breakdown (avoids a bandwagon effect) — the presenter's own screen is what gets projected, so this had to become an actual constraint in the code, not just a UI choice. A live **count** of how many votes have come in (no breakdown by choice) is fine to show during voting. — **Built**: the admin panel shows only a running total while open; the per-choice breakdown is revealed only after closing.
- **One-vote-per-participant safeguard**: not bulletproof (this isn't a legal election) — a random per-device id stops trivial double-voting; voting again just overwrites the previous choice. — **Built.**
- **Procurations (proxy votes)** — a significant addition from the President's answer: a member can hold a proxy to vote on someone else's behalf, and this must not be self-declarable (a random person on the public link must never be able to claim extra votes). Solution: the admin generates a personal, unguessable link per proxy-holder (name + vote weight, e.g. "self + 2 proxies" = weight 3); the weight lives only in the database and is looked up server-side on every vote — never trusted from the client. The list of who holds proxies for whom comes privately from the President (he collects it via DM, as required by the association's rules) and Nikita enters it into the tool close to the AG date. — **Built** (admin-side management: create/list/revoke a proxy link with its weight); the voter-side still needs the token-aware voting page.
- **PDF export**: a clean list of each question and its final result — confirmed this is for internal reference only (the official minutes/PV are filled in by hand), so no special formatting/letterhead needed. — Not yet built.
- A **manual fallback**: if wifi or the tool fails mid-AG, the team needs to be able to fall back to a show of hands without the meeting stalling. This should be a documented plan, not just a hope. — Not yet written up.
- **Language: the whole interface (admin and voter) is in French** — matches the AG audience and the President's own messages. Confirmed with Nikita, since this wasn't obvious until we knew who's actually using it. — **Built** for the admin view.

### Non-functional
- Must work reliably on a room full of mixed phones (iOS/Android, various browsers) — no app store install.
- **Scale — confirmed by the President:** ~250 people in the association total, so the tool should in theory support that many; realistically more like ~80 max attendees, roughly half in-person / half online, but everyone votes through the same site either way. Comfortably within what Postgres + Socket.IO handles without any special tuning.
- Should be simple enough that someone other than Nikita could run the presenter view — confirmed the President or VP usually runs it themselves (it goes with their speech), Nikita only if he's available and wants to. The shared-PIN approach already supports handing control to anyone who has the PIN.

## 3. Architecture — decided

**Update (25 Aug):** Jordan confirmed the team has its own infrastructure (one EPFL server, three VPS at AlphaVPS), two owned domains (`epfl-rocket-team.ch`, `epflrocketteam.ch`) registered at Infomaniak, DNS managed via Cloudflare — and that data should ideally stay in Switzerland or the EU. That settles the architecture question: **self-host on team-owned infrastructure**, not a third-party cloud like Firebase/Supabase.

- The **EPFL server** is physically in Switzerland — the strongest fit for the data-residency preference, if it's available for this use.
- The **AlphaVPS instances** are based in Sofia, Bulgaria — Bulgaria is an EU member state, so this also satisfies "stored in the EU" if the EPFL server isn't the right choice (e.g. it's locked down or used for other services).

**Stack:**
- Backend: Node.js + Express, with Socket.IO for the realtime push between voter and presenter views.
- Storage: **Postgres** (switched from an initial SQLite draft — Nikita is already familiar with Postgres, and it fits the team's infra better long-term). Local dev runs against either a native Postgres install or the `docker-compose.yml` in the repo.
- Reverse proxy + TLS: Caddy or Nginx with Let's Encrypt on the VPS/server, or TLS terminated at Cloudflare if the domain is proxied through it.
- Frontend: plain HTML/CSS/JS, mobile-first responsive layout, no framework, no build step. Brand colors sampled from the team logo (red `#b92a30`, near-black `#010207`), white page background.
- PDF export: client-side (jsPDF, vendored locally rather than loaded from a CDN, so it doesn't depend on internet access beyond the app's own domain).

This is slightly more setup than Firebase/Supabase (a server to configure vs. a managed service), but avoids sending participant data to a third party entirely, which is worth it given the residency preference — and the team already runs infra, so this isn't unfamiliar territory for IT.

## 4. Hosting — mostly resolved, one thing pending

Resolved: self-hosted on team infrastructure, under one of the two owned domains (e.g. a subdomain like `ag.epfl-rocket-team.ch` or `vote.epflrocketteam.ch`), DNS record added in Cloudflare pointing at whichever host we use.

Still open: **which specific machine** — the EPFL server, or one of the three AlphaVPS instances — and the credentials to access it. Jordan said credentials are coming soon. This is now the main blocking dependency for deployment; it doesn't block building the app itself, which can be developed and tested locally in the meantime.

### Exact checklist to request from Jordan

To deploy once and not have to change anything afterward, this is the full list — better to ask for all of it at once than to go back and forth as gaps turn up:

1. **Which machine** — EPFL server or one of the 3 AlphaVPS instances — and SSH access to it (host/IP, username, SSH key or password, and confirmation we have `sudo`, since we'll need to install Node.js and possibly Postgres).
2. **What's already running there** — is this a blank machine, or is it already serving other Rocket Team services? If there's already an Nginx/Caddy reverse proxy in front of other apps, we should plug into that existing setup from the start rather than run our own on the same ports and conflict with it. Also worth knowing the Node.js version already installed, if any.
3. **Database approach** — either (a) we install our own Postgres on that machine (just needs the sudo access from #1, nothing extra), or (b) IT already runs a shared Postgres we should connect to instead — if (b), we need host, port, database name, username, password, and whether it requires SSL.
4. **Confirm the subdomain** — e.g. `ag.epfl-rocket-team.ch` — and who adds the DNS record in Cloudflare: either Jordan/IT adds an A record pointing at the server's IP once we give it to them, or we get Cloudflare access ourselves. The former is simpler and needs less credential-sharing.
5. **Firewall / open ports** — confirmation that ports 80 and 443 are reachable from the internet on that machine (needed for the site itself and for Let's Encrypt to issue a TLS certificate), or, if there's a shared reverse proxy per #2, that IT can add a route for our subdomain instead.
6. **Any existing backup/monitoring convention** the team uses on their infra, so we fit into it rather than bolt on something incompatible (not essential, just nice to align on).

Getting all of this in one message avoids the situation where we deploy, discover a conflict (e.g. port 443 already used by another app on that server) partway through, and have to rework the deployment under time pressure.

## 5. Timeline (14 days)

| Dates | Milestone |
|---|---|
| Aug 25–27 | Finalize spec & question types with President; confirm hosting approach with Jordan |
| Aug 28–31 | Build core: admin view (create/open/close questions), voter view (join, vote once) |
| Sep 1–3 | Live tally + sync between in-person/online, PDF export |
| Sep 4–5 | Testing: simulate a full AG (multiple devices, spotty wifi, expected attendee count) |
| Sep 6–7 | Buffer for fixes, deploy to final hosting, prepare QR codes/links, write the manual-fallback plan |
| Sep 8 | AG — live use |

## 6. Risks

- **Venue wifi/connectivity** — mitigate with the manual fallback plan and by testing on-site beforehand if possible.
- **Device variety** — test on a real mix of phones before the AG, not just Nikita's own.
- **Double voting** — acceptable low-effort safeguard (e.g. one vote per browser session per question) rather than full authentication, unless the President wants stricter guarantees.
- **Tight timeline** — self-hosting adds some DevOps setup (server config, TLS, deployment) compared to a managed backend; start building the app locally now so deployment is the only thing waiting on Jordan's credentials.
- **Credentials arriving late** — if SSH/DNS access comes in only a few days before the AG, there may not be much runway to test on the real domain. Worth asking Jordan to prioritize this by Sep 3 (see Section 4).

## 7. Questions to bring back to the President / Jordan

Answered (President, 26 Aug — see Section 2 for how each landed in the build):
- ~~Hosting/domain preference~~ / ~~data residency~~ — resolved earlier, see Section 4.
- ~~Multiple-choice needed?~~ — yes, but the default is "Oui/Non/Blanc"; custom option lists available per-question when needed.
- ~~Expected headcount~~ — ~250 in the association, realistically ~80 max at an AG, split roughly half in-person/online, all voting through the same site.
- ~~PDF formatting~~ — internal use only, no special formatting needed.
- ~~Who runs the panel~~ — normally the President/VP, Nikita as backup.
- **New, not something we'd asked about**: procurations (proxy votes) — see Section 2, now designed and partly built.

Still open:
- Which specific host (EPFL server vs. an AlphaVPS instance) and when credentials will be available (see Section 4) — still waiting on Jordan.
- The actual list of AG questions and the list of proxy-holders (name + weight) — both come from the President, ideally with enough lead time to enter the proxies before Sep 8 and ideally the questions too (though the tool supports adding them live if needed).

## 8. Progress so far (as of 26 Aug)

- **Backend** (Express + Socket.IO + Postgres): questions CRUD, open/close (only one live at a time), voting with the hidden-while-open / revealed-on-close results split, weighted procuration voting via personal tokens, PIN-gated admin routes. Tested end-to-end (API tests + a real headless-browser run of the admin UI) after every change.
- **Admin (presenter) view**: PIN gate, create/edit/delete draft questions (standard or custom type), open/close, live participation counter, final weighted results with percentage bars, procuration management (create/list/revoke personal voting links). Fully in French, styled with the team's brand colors and logo.
- **Not yet built**: the voter-facing page (French, mobile-first, token-aware for proxy links), PDF export, the deployment/manual-fallback writeups.

## 9. Next step

Build the voter view (French, mobile-first — the page most people will actually use, and it needs to handle both anonymous voting and the `?token=...` proxy links), then PDF export, then deployment once Jordan's access details arrive.