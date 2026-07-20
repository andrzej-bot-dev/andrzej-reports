# recording_kit.md — Checklist do nagrania odcinka 1

## 🎬 OBS Setup

### Sceny OBS:
1. **Main** — Full IDE + twarz (kamera PiP w rogu)
   - VS Code na fullscreen
   - Kamera: prawy dolny róg, ~250×180px, lekko zaokrąglona
   - Terminal: dolna 1/4 ekranu (pokazuje output obok VS Code)

2. **Face-only** — Intro/outro/Plan mode
   - Twarz na środku, ciemne tło
   - Używane na początku ("co zbudujemy") i przy Plan mode

3. **Browser** — Demo finalnej apki i deploy
   - Full browser window (Chrome)
   - Czyste okno, bez pasków zakładek

4. **Terminal-only** — Instalacja zależności, git
   - Full terminal
   - Czcionka: 16-18px, białe na czarnym

### Rozdzielczość: **1920×1080** (1080p)

### Mikrofon:
- Anker PowerConf (zapisany w TOOLS.md)
- Gain: ~80%
- Filtr noise suppression: RNNoise (wbudowany w OBS 30+)
- Test nagrania: 30s przed każdym rozdziałem

## 🪟 Co mieć otwarte w oknach

- **VS Code** (główne okno)
  - Projekt jira-clone otwarty
  - Terminal zintegrowany na dole
  - Cline sidebar otwarty (Plan mode na start)
  
- **Chrome** (drugie okno — do przełączania w Scene 3)
  - `localhost:3000` — wersja dev
  - Druga karta: Vercel dashboard
  
- **Terminal** (Scene 4)
  - Do `npm install`, `npx`, `git`

## 📝 Roboczy tytuł + opis

### Tytuł (5 opcji):
1. **"Build a Fullstack Jira Clone with AI Agents — $0 Tools (2026)"** ⭐
2. "I Built a SaaS with AI Agents (and It Was Wrong 3 Times)"
3. "Next.js 15 Fullstack Project: Jira Clone with Free AI Tools"
4. "Coding with AI in 2026: Build a Real App from Scratch ($0)"
5. "The Truth About AI Coding: Building a Jira Clone with Cline"

### Opis (template):
```
🔥 Build a fullstack project management app with Next.js 15 — using 100% FREE AI tools!

In this video, we build a Jira clone from scratch:
✅ Next.js 15 App Router + TypeScript
✅ Prisma + SQLite (free, no setup)
✅ NextAuth v5 authentication
✅ Kanban board with drag & drop
✅ AI agent as your pair programmer (Cline + Copilot Free)

💰 Total cost to build: $0
⏱️ Full build: ~5 hours
📦 Starter repo: [GITHUB LINK]

I'm back after 2 years — and AI has changed everything. But the skill that matters most in 2026 isn't writing code. It's making decisions. Let me show you what I mean.

⏰ Timestamps:
0:00 - What we're building
2:30 - $0 tool setup
8:00 - Architecture (Plan mode)
12:30 - Database schema
25:00 - Auth setup
35:00 - Dashboard UI
55:00 - Projects CRUD
1:25:00 - AI makes its first mistake (debugging live)
1:30:00 - Kanban board
2:45:00 - AI's second mistake
3:30:00 - Polish & deploy
4:50:00 - What we learned about coding with AI

#nextjs #ai #programming #webdev #cline
```

## 🎨 Koncepty miniatury (3 opcje)

### Koncept A: "Decision Maker"
- Split screen: lewa strona — Dawid myślący/planujący (zdjęcie), prawa strona — kod generowany przez AI
- Duży tekst: **"AI WRITES THE CODE"** / mały tekst: **"I MAKE THE DECISIONS"**
- Czerwony X na złym kodzie AI, zielony ✅ na poprawionym
- Branding: logo "Coding With Dawid" + "2026" w rogu

### Koncept B: "Before/After AI"
- Górna połowa: messy AI code z czerwonymi podkreśleniami błędów
- Dolna połowa: czysty, działający kod z zielonym tłem
- Tekst: **"AI GOT IT WRONG 3 TIMES"** / **"Here's how I fixed it"**
- Emoji: 🤖❌ → 🧠✅

### Koncept C: "The $0 Stack"
- Układ kafelkowy: VS Code, Cline, Copilot, Next.js — każde z ceną "$0"
- Centralny tekst: **"BUILD THIS FOR $0"**
- W tle: zrzut finalnej aplikacji (dashboard)
- Każde narzędzie z checkmarkiem ✅

**Rekomendacja:** Koncept A — najlepiej komunikuje wyróżnik (pedagogika, nie tylko kodowanie).

## ✅ Pre-flight checklist

- [ ] OBS sceny skonfigurowane i przetestowane
- [ ] Mikrofon: gain + noise suppression OK
- [ ] Starter repo sklonowane lokalnie
- [ ] VS Code + Cline + Copilot zainstalowane
- [ ] Demo finalnej apki gotowe (do pokazania na początku)
- [ ] Cline Rules file sprawdzony
- [ ] Nagraj 2-min test przed właściwym nagraniem
- [ ] Wyłącz powiadomienia (Slack, Discord, telefon)
- [ ] Zamknij niepotrzebne karty/okna
- [ ] Rozdzielczość 1080p potwierdzona
- [ ] Backup plan: drugie nagranie audio na telefon (safety)

## 🎯 Minimalny setup (jeśli OBS nie działa)

Nagraj na:
1. OBS (główne)
2. QuickTime/SimpleScreenRecorder (backup)
3. Telefon (audio backup — Voice Memos)

Nigdy nie polegaj na jednym źródle nagrania.
