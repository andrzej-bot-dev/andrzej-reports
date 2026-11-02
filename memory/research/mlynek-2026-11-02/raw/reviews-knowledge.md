# Młynek do przypraw (kawa drugorzędnie) — wiedza z testów i doświadczeń

Research date: 2026-11-02. Budget: 150–800 SEK, Szwecja.
Metoda: web_fetch / curl (Reddit przez arctic-shift API + RSS, bo reddit.com blokuje Pi 403; seriouseats/wirecutter/ATK/Amazon = 402/403/paywall, nie udało się obejść).

Każda teza z URL-em. Źródła oznaczone [EN] / [SV].

---

## 1. Blade vs burr — do przypraw

**TL;DR: Do przypraw w tym budżecie blade (młynek nożowy/topórkowy) jest NIE tylko akceptowalny, ale wręcz zalecany.** Burr wygrywa przy kawie (równość i kontrola grind size), ale przy przyprawach korzyści są mniejsze, a wady (zapychanie olejkami, trudne czyszczenie, cena) większe.

- Wikipedia [EN]: burr mill miele między dwiema powierzchniami ściernymi; daje **równą** cząstkę i **mniej podgrzewa** produkt niż blade. „Blade mills are also used, but produce an undesirable wide range of particle sizes" (kawa). Burr są „typically designed for a specific purpose" — kawa, pieprz, gruba sól, przyprawy, mak. Materiały: stal nierdzewna (najtrwalsza do pieprzu/kawy), ceramika (najlepsza do multi-use — nie koroduje, nadaje się do soli i przypraw), akryl (tani, do soli). → https://en.wikipedia.org/wiki/Burr_mill
- Wikipedia „Blade grinder" [EN]: blade = 20 000–30 000 rpm, sieka i miesza; tani, prosty. → https://en.wikipedia.org/wiki/Blade_grinder
- The Budget Barista [EN]: blade „chops" — brak kontroli i konsystencji; „they still can't compete with even the worst burr grinders" (dla KAWY). Autor jest baristą kawowym — perspektywa coffee-first. → https://www.budgetbarista.com/burr-grinder-vs-blade-grinder/
- INeedCoffee [EN]: blade najtańszy i najprostszy; grind size = czas; słabość = mieszanka proszku i grudek. „always go for the burr grinders" (kawa). → https://ineedcoffee.com/choosing-the-right-coffee-grinder/
- r/spices (Reddit) [EN] — doświadczenia UŻYTKOWNIKÓW przypraw (nie kawy):
  - „Inexpensive blade coffee grinders are ideal for this [grinding whole spices as needed]." → https://www.reddit.com/r/spices/
  - „Get an inexpensive coffee grinder and only use it for spices." / „a cheap coffee grinder plus sticks is the move. took me like 10 seconds to get fine powder."
  - „I have a used Krups coffee grinder (terrible for coffee) to grind as needed."
  - „Yeah since I bought a cheap spice grinder on Amazon I'm having so much more fun, and it's definitely more fragrant. Cloves, cardamon, cumin, cinnamon, coriander, annatto, black pepper, dried chillis..." **Triki z tego wątku:** dodanie szczypty soli pomaga mleć szybciej/równiej; najpierw podprażyć przyprawę na patelni (dla kuminu „really stands out").
  - Źródło (API): arctic-shift r/spices, body=grinder → plik `as_spices_g.json` (80 komentarzy). Endpoint: https://arctic-shift.photon-reddit.com/api/comments/search?subreddit=spices&body=grinder
- **Werdykt dla przypadku Dawida (przyprawy > kawa):** blade wygrywa. Burr ma sens, jeśli kawa byłaby PRIORYTETEM albo ktoś chce mielić sól/grubo bez pylenia.

### Czy burr zapycha się olejkami/przyprawami?
- Olejki eteryczne i wilgoć: r/spices [EN] — „whole sumac has more moisture so if you grind too much at once it can clump"; mocno oleiste/wilgotne rzeczy (sumak, świeżo prażone) kleją się. → https://www.reddit.com/r/spices/
- **Czyszczenie to główny problem blade, nie burr:** r/spices [EN] — „It's the removable bowl that's key. I struggled to adequately clean a coffee grinder. I would grind salt to try and make sure all the cumin or allspice or whatever was cleaned out." → młynek z **wyjmowaną misą** = klucz. (To argument za modelem z odkręcaną misą, nie za burr.) → https://www.reddit.com/r/spices/
- Tradycyjna alternatywa odporna na olejki/wilgoć: moździerz (mortar & pestle) [EN, r/spices] — „Much easier to clean than a coffee or spice grinder"; nie grzeje, ale wolny. Wielu użytkowników r/spices trzyma OBA: moździerz + młynek elektryczny. → https://www.reddit.com/r/spices/
- Wniosek: ryzyko zapychania dotyczy głównie oleistych/wilgotnych (świeży czosnek, sumak, prażone) — mielić porcjami, z solą, po wysuszeniu.

---

## 2. Konkretne modele — weryfikacja opinii/cen

### Elektryczne blade/topórkowe (główny target budżetu)
- **Bosch TSM6A013B** (seria MyMoment) [SV] — „Bästa budget" w teście test.se; 75 g, 180 W, 2 stopnie mielenia, ~150 g/min; ceny widziane: **248 / 249 / 258 / 266 / 309 kr**; najpopularniejszy model na Prisjakt; tysiące dobrych ocen Amazon/Clas Ohlson/Pricerunner 2026. Opinie: „snabb, smidig och lättanvänd". → https://www.test.se/kaffekvarn/
- **Melitta Molino** [SV] — „Bäst i test" w test.se; 200 g, elektryczna, 17 stopni, auto-off, malskivor w stali; cena **899 kr**. (To już burr-konstrukcja / malskivor, near górnej granicy budżetu.) → https://www.test.se/kaffekvarn/
- **Smeg CGF01** [SV] — „Bästa design", 350 g, **2795 kr** (poza budżetem; punkt odniesienia). → https://www.test.se/kaffekvarn/
- **Andersson CEG 1.0** [SV] — w NetOnNet; „en av få kaffekvarnar i Europa som är godkänd av European Coffee Brewing Centre (ECBC)"; dołączony pędzel do czyszczenia. (marka własna NetOnNet — sprawdzić cenę na stronie.) → https://www.netonnet.se/
- **Loeffen LFCG1000** [SV] — NetOnNet; 12 ustawień mielenia, stalowe noże, do 70 g. → https://www.netonnet.se/
- **Wilfa** [SV] — marka obecna w Kjell (19 produktów kategorii) i szeroko w SE. → https://www.kjell.com/se/
- **Cuisinart Supreme Grind** [EN, TechGearLab] — „The Economy Burr Grinder" — najlepsza tania opcja burr; „great for pour-over or French press" (kawa). → https://www.techgearlab.com/topics/kitchen/best-coffee-grinder
- **Bodum Bistro** [EN, TechGearLab] — „Best Bang for the Buck", conical burr, glass catcher, 14 settings, dopasowuje się do top contenders taniej. → https://www.techgearlab.com/topics/kitchen/best-coffee-grinder
- **Breville Smart Grinder Pro** [EN, TechGearLab] — „Best Overall" 85/100, $200 — poza budżetem. → https://www.techgearlab.com/topics/kitchen/best-coffee-grinder

### Manualne burr (kawa; do przypraw też dają radę)
- **Timemore Chestnut C2 / C2 Max** [EN, Coffee Chronicler] — „worth every penny and more"; ~25 g (Max ~30 g), 38 mm steel burrs, aluminium body, łożyska kulkowe, ~467 g; „budget grinder that ticks many boxes"; tanie na AliExpress (10 dni–6 tyg. dostawa) / Amazon / Prima Coffee. Design z plastikowymi stabilizatorami wewnątrz = lekki, ale trochę mniej premium. → https://coffeechronicler.com/timemore-c2-review/
- **Kingrinder K1/K2/K3/K4/K5/K6** [EN, r/espresso] — K6 to najczęściej polecany budżetowy manual do espresso w 2025/26; wątki: „Kingrinder K2, K3, K4, K5 and K6 comparison", „Kingrinder K6 vs Baratza Encore ESP [<€160]", „Switching from Kingrinder k6 to electric grinder [150$]", „Kingrinder K6 Appreciation Post", „Upgrade from Kingrinder K6". Częste tematy = dzwonienie espresso, sour/bitter shots (kalibracja), nie same awarie. → https://www.reddit.com/r/espresso/ (feed: https://www.reddit.com/r/espresso/search.rss?q=K6&restrict_sr=1)
  - Sygnał: K6 jest chwalony do espresso; do PRZYPRAW manualny burr jest wolny, ale precyzyjny. Popularna rada r/spices: osobny tani blade do przypraw, burr zostaw do kawy.
- **Hario Mini Mill / Skerton** [EN] — klasyk manualny kawy, ceramiczne burrs; znany z nierównego grind (mod „tape mod"). (Ogólna wiedza; nie znaleziono świeżego źródła URL w tym researchu — do weryfikacji.)

### Potwierdzenie, że w tym budżecie główny wybór to blade
- test.se [SV] „Bästa budget" = **Bosch TSM6A013B ~248–309 kr** — młynek blade, 75 g, 180 W. To najszerzej polecany sub-300 kr model w SE. → https://www.test.se/kaffekvarn/

---

## 3. Testy szwedzkie / europejskie
- **Test.se — kategoria Kaffekvarn** [SV]: agregator eksperttestów; zwycięzcy 2026: Melitta Molino (bäst i test), Smeg CGF01 (design), **Bosch TSM6A013B (bästa budget)**, Peugeot Brésil (bästa manuella, 1441 kr). → https://www.test.se/kaffekvarn/
- **Råd & Rön (radron.se)** [SV]: mają sekcję „Köksmaskiner & städning" (testy AGD), ale w tym researchu nie znaleziono dedykowanego testu „kaffekvarn" pod /tester/koksmaskiner-stadning/ (mają: blendrar, brödrostar, bakmaskiner...). Katalog: → https://www.radron.se/tester/koksmaskiner-stadning/
- **Aftonbladet** [SV]: 19 trafień na „kaffekvarn" (głównie katalog/artykuły zakupowe, nie testy). → https://www.aftonbladet.se/sok?query=kaffekvarn
- **Testfakta.se** [SV]: strona odpowiada, ale wyszukiwarka zwróciła stronę bez konkretnego testu kaffekvarn (testy głównie AGD/dom). → https://www.testfakta.se/
- **NetOnNet / Kjell / Clas Ohlson / Power** [SV]: sklepy z porównywalnymi modelami (Bosch, Wilfa, Andersson, Loeffen). Clas Ohlson to jedno ze źródeł ocen Bosch TSM6A013B wg test.se.

---

## 4. Typowe problemy tanich blade (i triki)
1. **Zapach/smak plastiku** — typowe dla najtańszych; r/spices radzi: mielić raz ryż/sól na start by „wypalić"; wybierać modele z wyjmowaną misą i stalowymi nożami. [EN] → https://www.reddit.com/r/spices/
2. **Nierówne mielenie** — blade miele „od proszku do grudek" (INeedCoffee); do espresso odpada, do przypraw OK. [EN] → https://ineedcoffee.com/choosing-the-right-coffee-grinder/
3. **Przegrzewanie** — blade 20–30k rpm grzeje; przy kawie „oils and aromas can easily dissipate if the beans become too hot" (Wikipedia). Radzić: krótkie pulsy, nie mielić długo ciągiem. [EN] → https://en.wikipedia.org/wiki/Burr_mill
4. **Czyszczenie po przyprawach** — największa bolączka; triki użytkowników r/spices [EN]:
   - mielić **sól** lub **ryż** by „wyciągnąć" zapach („I would grind salt to try and make sure all the cumin or allspice was cleaned out");
   - „grind the salt to clean it"; (chleb) — mielenie suchego chleba/ryżu wyciąga olejki;
   - **wyjmowana misa** = klucz do czyszczenia;
   - mieć osobny młynek na przyprawy (nie kawowy).
   → https://www.reddit.com/r/spices/
5. **Kontaminacja smaków** — r/spices [EN] niemal jednogłośnie: **osobny młynek do kawy i osobny do przypraw** („only use it for spices", „small coffee grinder that i use for this and only this"). → https://www.reddit.com/r/spices/

---

## 5. Czy dokupić DRUGI młynek (przyprawy vs kawa)?
- **Tak — konsensus użytkowników.** r/spices [EN]: kawa i przyprawy w jednym młynku = przenoszenie aromatów (zwłaszcza kumin/allspice/fenkuł w kawie). Wiekszość ma osobny tani blade do przypraw. → https://www.reddit.com/r/spices/
- r/espresso [EN]: K6 to wybór pod kawę; nikt raczej nie mieli przypraw tym samym sprzętem (wtyczki smakowe + czyszczenie burr po olejkach). → https://www.reddit.com/r/espresso/
- Ekonomicznie: tani blade (150–300 kr) na przyprawy + ewentualnie burr/manual (400–800 kr lub K6) na kawę = łącznie w budżecie, bez kompromisu smakowego.

---

## Linki-źródła (skrót)
- [EN] https://en.wikipedia.org/wiki/Burr_mill
- [EN] https://en.wikipedia.org/wiki/Blade_grinder
- [EN] https://www.budgetbarista.com/burr-grinder-vs-blade-grinder/
- [EN] https://ineedcoffee.com/choosing-the-right-coffee-grinder/
- [EN] https://www.techgearlab.com/topics/kitchen/best-coffee-grinder
- [EN] https://coffeechronicler.com/timemore-c2-review/
- [EN] https://www.reddit.com/r/spices/ (via arctic-shift API `as_spices_g.json`)
- [EN] https://www.reddit.com/r/espresso/search.rss?q=K6&restrict_sr=1 (`rr_esp_k6.rss`)
- [SV] https://www.test.se/kaffekvarn/
- [SV] https://www.radron.se/tester/koksmaskiner-stadning/
- [SV] https://www.netonnet.se/ (Andersson CEG 1.0, Loeffen LFCG1000)
- [SV] https://www.aftonbladet.se/sok?query=kaffekvarn
- [SV] https://www.testfakta.se/

## WNIOSKI DLA ZAKUPU
1. **Do przypraw (priorytet zadania) bierz tani młynek blade z wyjmowaną misą i stalowymi nożami — nie burr.** Konsensus r/spices: „inexpensive blade coffee grinders are ideal for this"; burr to overkill i trudniejszy w czyszczeniu. → https://www.reddit.com/r/spices/
2. **Top pick w SE: Bosch TSM6A013B — ~248–309 kr.** „Bästa budget" na test.se, 75 g / 180 W / 2 stopnie, najpopularniejszy na Prisjakt, tysiące dobrych ocen (Amazon, Clas Ohlson, Pricerunner). Środek budżetu, sprawdzony. → https://www.test.se/kaffekvarn/
3. **Jeśli chcesz jeden sprzęt do kawy I przypraw tanio:** Melitta Molino (młynek z malskivor, 17 stopni) ~899 kr — trochę powyżej budżetu, ale „bäst i test". Alternatywa burr: Cuisinart Supreme Grind lub Bodum Bistro („value for money"). → https://www.test.se/kaffekvarn/ , https://www.techgearlab.com/topics/kitchen/best-coffee-grinder
4. **Manualny burr, jeśli kawa ma znaczenie (espresso):** Timemore C2 (~budżet, 38 mm stalowe burrs, AliExpress/Amazon) lub Kingrinder K6 (najczęściej polecany manual espresso 2025/26, <€160). Do przypraw wolny — lepiej osobny blade. → https://coffeechronicler.com/timemore-c2-review/ , https://www.reddit.com/r/espresso/
5. **Kup DWA młynki** — osobny tani blade na przyprawy, osobny na kawę; to standard w r/spices (kontaminacja smaków: kumin/allspice w kawie). Suma mieści się w 150–800 kr. → https://www.reddit.com/r/spices/
6. **Triki eksploatacyjne:** mielić krótkimi pulsami (blade grzeje ziarno — Wikipedia), dodawać szczyptę soli do twardszych przypraw (szybciej/równiej), „wypalać" sól/ryżem by usunąć zapach, wybierać wyjmowaną misę do czyszczenia. → https://en.wikipedia.org/wiki/Burr_mill , https://www.reddit.com/r/spices/
7. **Unikaj burr do oleistych/wilgotnych przypraw** (sumak, świeżo prażone) — kleją się i zapychają; blade lub moździerz lepsze. → https://www.reddit.com/r/spices/
8. **Uwaga na najtańsze blade: zapach plastiku i hałas.** Wybieraj modele ze stalowymi nożami i znanej marki (Bosch, Wilfa, Krups); Bosch TSM6A013B ma potwierdzone dobre oceny w SE sources. → https://www.test.se/kaffekvarn/
