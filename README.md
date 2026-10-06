# Linux Lab – oefeningen met mappenstructuren, volledig in de browser

Een interactieve (gesimuleerde) Linux-shell die een **willekeurige** oefening uitdeelt:
een doelstructuur van mappen en bestanden die de student in `~/work` moet bouwen met
de echte commando's `ls pwd cd cp mv touch mkdir rm rmdir tree`. Alles draait client-side
in TypeScript (Vite + xterm.js) en wordt gehost op GitHub Pages; er is geen server.

- Standaard **Nederlands**, met een NL/EN-knop rechtsboven (`?lang=en` werkt ook).
- Het lab (`/home/student/work`, `/home/student/stock`) is een virtueel bestandssysteem in het
  geheugen en wordt in `localStorage` bewaard, dus een refresh gaat verder waar je was.
- `?seed=4242` geeft iedereen dezelfde oefening, `?level=1|2|3` kiest de grootte.

## Een oefening

```
  work/
  ├── api/                ◆ maak het aan met een ABSOLUUT pad
  │   ├── notes.txt       ★ geen mkdir/touch → kopieer of verplaats het vanuit ~/stock/notes.txt
  │   └── schema.sql      ◆ maak het aan met een RELATIEF pad
  ├── images/             ★ geen mkdir/touch → kopieer of verplaats het vanuit ~/work/images_backup
  │   └── data.csv        (gaat automatisch mee met de map erboven: ~/work/images_backup/data.csv)
  └── src/                (staat er al)
```

`~/work` moet er op het einde EXACT zo uitzien, en alles wat in de lijst "Verwijder uit ~/work"
staat moet weg.

## De regels en hoe ze afgedwongen worden

| Regel | Afdwinging |
|---|---|
| ★ items mogen niet met `mkdir`/`touch` gemaakt worden | het commando wordt geweigerd; `check` controleert ook dat het het originele bestand is (elk draagt een uniek ID), een ander bestand kopiëren volstaat dus niet |
| ◆ items moeten met een absoluut of relatief pad gemaakt/verwijderd worden | het argument wordt bekeken; `~/...` telt als absoluut |
| "enkel rmdir"-mappen mogen niet met `rm` verwijderd worden (of weggeschoven) | geweigerd, ook via een recursieve `rm` van de bovenliggende map |
| enkel de opgesomde commando's, geen pipes/omleidingen/ketens | geweigerd (wildcards werken wel) |
| WILDCARD-groep: bestanden in `~/stock` die met één patroon (`*` of `?`) verplaatst moeten worden | `cp`/`mv` met de bestandsnaam zelf wordt geweigerd; gelijkaardige bestanden (bv. `les10.txt` naast `les?.txt`) blijven liggen, een te gulzig patroon geeft dus extra bestanden in `check` |
| ◆ pad "dat met `~` begint" | enkel `~/...` volstaat, `/home/student/...` niet |
| ★ "gebruik `.` als bestemming" | je moet eerst met `cd` naar de doelmap en dan `cp`/`mv` met `.` als bestemming gebruiken |
| blijf binnen de labmap | elk pad buiten `/home/student` wordt geweigerd; `cd` kan er niet uit |

Een geweigerd commando wordt nooit uitgevoerd; overtredingen worden geteld en getoond door `check`.
`cp -r . ~/x` kopieert de *inhoud* van de huidige map (zoals het echte `cp`), en `map/./sub` is hetzelfde als `map/sub`.
`hint` wijst één openstaand item aan zonder het commando te geven.

## Ontwikkelen

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # vitest: genereert 180 oefeningen en lost ze allemaal op met enkel lab-commando's
npm run build     # tsc + vite build naar dist/
```

| Bestand | Inhoud |
|---|---|
| `src/generator.ts` | willekeurige oefening uit een seed (`LEVELS`, naamlijsten bovenaan) |
| `src/lab.ts` | regelcontrole (`vet`), meta-commando's, `check`, `hint`, opdracht, tab-aanvulling |
| `src/commands.ts` | `ls cp mv rm rmdir mkdir touch tree` op het virtuele bestandssysteem |
| `src/vfs.ts` | bestandssysteem in het geheugen |
| `src/shell.ts` | tokenizer en wildcards |
| `src/session.ts` | bewaren/hervatten van een lab |
| `src/main.ts`, `index.html` | terminal (xterm.js), knoppen, taalwissel |
| `src/i18n.ts` | `tr(english, nederlands)` voor alle tekst |

De uitvoer van de commando's zelf (bv. `No such file or directory`) blijft Engels, zoals bij echte
Linux-tools.

## Publiceren

`.github/workflows/pages.yml` test, bouwt en publiceert bij elke push naar `main`.
Eenmalig: repo **Settings → Pages → Source: GitHub Actions**.

> De vroegere Python-versie (CLI, Docker-server met leerkrachtendashboard, bewijscodes) staat
> enkel nog in de git-geschiedenis. Een statische site heeft geen server voor een dashboard en
> geen geheime sleutel voor bewijscodes.
