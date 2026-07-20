# episode_1_plan.md — Odcinek 1: Plan

## Temat

**"Build a Fullstack Jira Clone with Next.js 15 + AI Agents — $0 Tools (2026)"**

Fullstack bug tracker / project management dashboard. Widzowie budują prawdziwy produkt, uczą się pracować z AI, i wszystko za $0.

## Stack (dla widza — $0)

| Warstwa | Technologia | Koszt |
|---------|------------|-------|
| Editor | VS Code | $0 |
| AI Agent | Cline (open source) | $0 |
| AI Autocomplete | GitHub Copilot Free | $0 |
| Framework | Next.js 15 (App Router) | $0 |
| Język | TypeScript | $0 |
| Stylowanie | Tailwind CSS + shadcn/ui | $0 |
| Baza | SQLite + Prisma | $0 (plik lokalny) |
| Auth | NextAuth v5 | $0 |
| State | Zustand | $0 |
| Deployment | Vercel Hobby | $0 |

**Hook marketingowy:** "Wszystko za $0 — nawet karty kredytowej nie potrzebujesz."

## Format

- **Długość:** ~4–6h (jeden film, nie seria)
- **Short teaser:** 60s "co zbudujemy" na Shorts/TikTok przed premierą
- **Styl:** Full build-from-scratch, każdy krok pokazany
- **Twist:** Używamy AI agentów do budowania, ale TY podejmujesz decyzje

## Hook (pierwsze 30s)

> "Przez 2 lata nie było mnie na YouTube. W tym czasie AI nauczyło się pisać kod lepiej niż junior developer. Więc po co wracam? Bo teraz nie chodzi o pisanie kodu — chodzi o podejmowanie decyzji. W tym filmie zbudujemy pełną aplikację od zera, używając AI jako narzędzia, nie jako wymówki. I pokażę Ci dokładnie, kiedy AI się myli — i co z tym zrobić."

## Kąt pedagogiczny (wyróżnik po 2 latach)

> "Nie wracam, żeby pokazać Ci kolejny tutorial. Wracam, żeby nauczyć Cię jak pracować z AI w 2026 — bo to jest skill, którego nikt na YouTube jeszcze nie uczy dobrze. W tym filmie AI NIE zastąpi Twojego myślenia — będzie Twoim pair programmerem. A ja pokażę Ci, jak odróżnić dobry output od złego."

Zastosowane techniki z Krok 2c:
1. **Plan → Act:** Najpierw architektura na tablicy (5 min), potem implementacja z Cline
2. **Zły output AI:** Celowo pokazuję 2–3 momenty gdzie AI produkuje błędny kod i debuguję na żywo
3. **"Najpierw Ty":** Przed każdą większą sekcją — "zastanów się jakbyś to zrobił"
4. **Multi-agent rozdział (teaser):** Na koniec zapowiedź kolejnego odcinka o multi-agent workflow

## Outline (5–8 punktów)

1. **Intro + setup (15 min)**
   - Co zbudujemy (demo finalnej apki — 2 min)
   - Instalacja VS Code + Cline + Copilot Free
   - Cline Plan mode: architektura aplikacji

2. **Scaffolding + konfiguracja (20 min)**
   - `npx create-next-app` z App Router
   - Tailwind + shadcn/ui setup
   - Prisma + SQLite setup
   - NextAuth v5 konfiguracja

3. **Database schema + auth (30 min)**
   - Prisma schema (projects, issues, comments, users)
   - NextAuth z GitHub provider (albo credentials)
   - Protected routes middleware

4. **Core UI — Dashboard + Projects (60 min)**
   - Dashboard layout z shadcn/ui
   - Projects CRUD
   - Pokazanie jak Cline generuje komponenty
   - **Moment #1: AI daje zły pattern (n+1 queries) — debugowanie na żywo**

5. **Issues — serce aplikacji (90 min)**
   - Issues CRUD z priorytetami, statusami, assignee
   - Kanban board (drag & drop)
   - Filter + search
   - **Moment #2: AI źle implementuje drag & drop — fix na żywo**

6. **Polishing + deployment (30 min)**
   - Dark mode, loading states, error handling
   - Deploy na Vercel (free)
   - **Moment #3: AI over-engineeruje prosty component — refactor na żywo**

7. **Wrap-up + next episode tease (10 min)**
   - Czego się nauczyliśmy o pracy z AI
   - "W następnym odcinku: multi-agent teams"
   - Link do repo + zaproszenie do komentarzy

## Starter repo — co będzie zawierać

Nie pusty template — DAJĘ widzom gotowy szkielet z:
- Next.js 15 + TypeScript + Tailwind skonfigurowane
- shadcn/ui dodane
- Prisma + SQLite schema (pusta)
- NextAuth v5 boilerplate
- Folder structure gotowy
- Cline `.clinerules` z zasadami projektu

**Repo URL** (do utworzenia): `github.com/CodingWithDawid/jira-clone-starter`
