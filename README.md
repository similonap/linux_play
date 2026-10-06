# Linux Lab – oefeningen met mappenstructuren, volledig in de browser

Een interactieve (gesimuleerde) Linux-shell die een **willekeurige** oefening uitdeelt:
een doelstructuur van mappen en bestanden die de student in `~/work` moet bouwen met
de echte commando's `ls pwd cd cp mv touch mkdir rm rmdir tree`. Alles draait client-side
in TypeScript (Vite + xterm.js) en wordt gehost op GitHub Pages; er is geen server.

- Standaard **Nederlands**, met een NL/EN-knop rechtsboven (`?lang=en` werkt ook).
- Het lab (`/home/student/work`, `/home/student/stock`) is een virtueel bestandssysteem in het
  geheugen en wordt in `localStorage` bewaard, dus een refresh gaat verder waar je was.
- Er zijn **twee soorten oefening, nooit gemengd**: een **boom** (bouw `~/work` na) of **opdrachten**
  (navigeren, gebruikers, groepen, rechten). Je kiest de soort bovenaan in ⚙ Instellingen.
- **⚙ Instellingen**: kies een moeilijkheid (makkelijk / gemiddeld / moeilijk: de grootte van de
  oefening plus welke onderdelen standaard aan staan) en vink daarna zelf aan wat je wilt oefenen:
  mappenstructuur, navigeren, gebruikers, groepen, kopiëren/verplaatsen, absolute paden,
  relatieve paden (`..`), `~`, `.` als bestemming, wildcard `*`, wildcard `?`, verwijderen en de
  rmdir-regel. Daarnaast zijn er snelkeuzes voor labo 3. Je keuze wordt in de browser bewaard en gebruikt voor elke nieuwe oefening.
- `?seed=4242` geeft iedereen dezelfde oefening. `?level=1|2|3` kiest de moeilijkheid en
  `?features=copymove,abs,rel,home,dot,star,question,remove,rmdironly` (komma-gescheiden, enkel
  wat je opsomt staat aan) kiest de onderdelen, bv. een link voor een les over wildcards:
  `?level=1&features=copymove,star,question`. Met enkel opdracht-onderwerpen (`?features=users,groups,rights`) wordt het
  een opdrachten-oefening.

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

## Labo 3: navigatie, gebruikers en groepen

In plaats van een boom kan een oefening uit **opdrachten** bestaan (kies "Opdrachten" in ⚙ Instellingen, of
een snelkeuze "Labo 3 · opdrachten"). De machine eromheen is een volledige simulatie met `/etc`, `/var/log`,
`/home/<user>`, gebruikers, groepen en rechten:

| Onderdeel | Commando's |
|---|---|
| Navigeren | `ls /etc`, `cd /var/log`, `cd`, `cd -`, `cd ..`, `cd /` |
| Gebruikers | `useradd`, `adduser` (stelt echt vragen), `passwd`, `userdel [-r]`, `su [-]`, `sudo`, `sudo -i`, `exit`, `whoami` |
| Groepen | `groupadd`, `groupdel`, `groupmod -n`, `usermod -a -G`, `groups`, `id`, `members` (eerst `sudo apt install members`) |

- Je bent `student` (paswoord `labolinux`, lid van `sudo`). Beheercommando's zonder `sudo` geven
  "Permission denied". Paswoordvragen worden niet getoond terwijl je typt.
- `su` en `sudo -i` veranderen wie je bent (de prompt volgt, `#` voor root), `exit` brengt je terug.
- `useradd` maakt **geen** home directory (zonder `-m`), `adduser` wel: dat verschil zie je door
  met `su` naar de nieuwe gebruiker te gaan.
- Rechten zijn echt: je kan buiten je eigen home niets maken of verwijderen, en bestanden krijgen de
  gebruiker die ze aanmaakte als eigenaar (`ls -l`).
- Elke opdracht wordt afgevinkt zodra je ze gedaan hebt (zichtbaar in `task`, `check` en de header).

## Labo 4: rechten en eigenaars

- Commando's: `chmod` (cijfers `640` en letters `u+x,g-w`, `a=r`, `-w`, `-R`), `chown` (`user`, `user:groep`,
  `user:`, `:groep`, `-R`) en `ll` (= `ls -alF`). Enkel de eigenaar (of root) mag `chmod`; enkel root geeft een
  bestand aan iemand anders; de eigenaar mag zelf wel een groep kiezen waar hij lid van is.
- **Rechten / Eigenaar in de structuur** (⚙, soort "Boom"): items in de boom krijgen `● rechten rw-r----- → met cijfers`,
  `● rechten 750 → met letters` of `♦ eigenaar:groep anna:users` (moeilijk: ook een map `met alles erin` = `chown -R`).
  `check` kijkt naar de rechten, de eigenaar/groep én met welke notatie de laatste `chmod` gebeurde.
- **Rechten & eigenaars** (⚙, soort "Opdrachten"): de oefeningen van de slides met `lab4a`, `lab4b`, `lab4c`, `~/linux-labo4`,
  `oef3` en (moeilijk) de ontbrekende home directory van `user1`. Snelkeuzes "Labo 4 · boom" en "Labo 4 · opdrachten".

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
| ● items: rechten met cijfers of met letters | `chmod` met de verkeerde notatie wordt geweigerd; `check` controleert de notatie ook (elke node onthoudt hoe zijn laatste `chmod` gebeurde) |
| blijf binnen de labmap | elk pad buiten `/home/student` wordt geweigerd; `cd` kan er niet uit |

Een geweigerd commando wordt nooit uitgevoerd; overtredingen worden geteld en getoond door `check`.
`cp -r . ~/x` kopieert de *inhoud* van de huidige map (zoals het echte `cp`), en `map/./sub` is hetzelfde als `map/sub`.
`hint` wijst één openstaand item aan zonder het commando te geven.

## Ontwikkelen

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # vitest: genereert honderden oefeningen (alle moeilijkheden en willekeurige combinaties van onderdelen) en lost ze op met enkel lab-commando's
npm run build     # tsc + vite build naar dist/
```

| Bestand | Inhoud |
|---|---|
| `src/generator.ts` | willekeurige oefening uit een seed (`LEVELS`, naamlijsten bovenaan) |
| `src/lab.ts` | regelcontrole (`vet`), meta-commando's, `check`, `hint`, opdracht, tab-aanvulling |
| `src/commands.ts` | `ls ll cp mv rm rmdir mkdir touch tree chmod chown` op het virtuele bestandssysteem (met rechten) |
| `src/admin.ts` | `useradd adduser passwd userdel groupadd groupdel groupmod usermod groups id members whoami apt` |
| `src/world.ts` | de gesimuleerde machine: gebruikers, groepen, `/etc`, `/var/log`, homes |
| `src/missions.ts` | de opdrachten (navigatie, gebruikers, groepen) en hun controle |
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
