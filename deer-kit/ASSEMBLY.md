# 🦌 Renifer 1.1 m — KIT montażowy (czarny PETG, Kobra S1)

**25 części** w `out/kit/*.stl`. Złącza: czop Ø7.6×16 → gniazdo Ø8.4 (rękaw Ø17). Klej: cyjanoakryl/epoxy.

## Przed drukiem całości
1. Wydrukuj `00_test_joint.stl` — sprawdź, czy czop Ø7.6 wchodzi w gniazdo Ø8.4 z lekkim oporem.
   - za luźno → zmniejsz otwór (re-print socket part), za ciasno → powiększ do 8.6.
2. Kalibracja first layer (pręciki Ø4 = mostki).

## Lista części

| plik | co to | uwagi |
|------|-------|-------|
| 01_torso_rear | tylna połówka torsu (pierścienie+podłużnice+czopy) | druk pionowo |
| 02_torso_front | przednia połówka + gniazdo szyi | druk pionowo |
| 03-06 leg_FL s1-s4 | lewa przednia noga, 4 segmenty | czop→gniazdo, s4 ma stopkę |
| 07-10 leg_FR s1-s4 | prawa przednia noga | jw. |
| 11-14 leg_HL s1-s4 | lewa tylna noga | jw. |
| 15-18 leg_HR s1-s4 | prawa tylna noga | jw. |
| 19_neck | szyja (stożek), czop dół / gniazdo góra | druk wzdłuż osi |
| 20_head | głowa + gniazda poroża | druk na boku |
| 21/22 antler_L/R | poroże (beam + 4 gałęzie + czop) | druk PŁASKO na stole |
| 23/24 earL/R | uszy | klej do głowy |
| 25_tail | ogon | klej do zadu |

## Montaż
1. Nogi: s1→s2→s3→s4 (czop w gniazdo + kropla kleju). 4 nogi.
2. Torso: rear+front — wsuń czopy podłużnic w gniazda, zetknij pierścienie stykowe, klej.
3. Nogi: czubek nogi (s1) PRZEŁOŻ przez dolny pierścień torsu w strefie biodra (noga wchodzi ~30 cm w górę) — przelot przez pręt = mocny punkt klejenia. Ustaw pion, klej na przecięciu.
4. Szyja: czop dolny → gniazdo na grzbiecie torso_front.
5. Głowa na szyję (czop→gniazdo).
6. Poroże L/R → gniazda na czubku głowy.
7. Uszy + ogon — klej.

## Parametry
- Wysokość po złożeniu: **~110 cm**, szerokość poroża ~60 cm
- Filament: ~0.67 kg lity + supports ≈ **0.75-0.85 kg czarnego PETG**
- Pręciki Ø4, nogi Ø10, czopy Ø7.6