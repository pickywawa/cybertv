# CyberTV — Spécifications & plan de développement

> Lecteur IPTV **légal** (l'app ne fournit aucun contenu : l'utilisateur apporte ses propres sources M3U / Xtream).
> Cibles : **Android TV**, **Android mobile/tablette**, **navigateur** (dev & test).
> Inspiration ergonomique : CANAL+ (sans copie de marque, logos, assets ou charte).

---

## 1. M3U vs API Xtream Codes

### 1.1 Lien M3U (M3U8 « étendu »)

Un simple fichier texte : une ligne `#EXTINF` (métadonnées) suivie d'une URL de flux.

```
#EXTM3U url-tvg="https://exemple/epg.xml.gz"
#EXTINF:-1 tvg-id="TF1.fr" tvg-name="TF1 FHD" tvg-logo="https://…/tf1.png" group-title="France | Généralistes" catchup="default" catchup-days="7",TF1 FHD
http://fournisseur:8080/live/user/pass/1234.ts
```

| Ce qu'on obtient | Ce qui manque |
|---|---|
| Liste plate de flux (live + parfois VOD/séries mélangés) | **Aucune structure** séries → saisons → épisodes (à reconstruire par heuristique sur les noms `S01 E02`) |
| Nom, logo, groupe (`group-title`), `tvg-id` | Pas de synopsis, casting, note, durée, affiche fiable, date d'ajout |
| URL EPG éventuelle (`url-tvg` / `x-tvg-url`) | Pas d'infos compte (expiration, connexions max) |
| Catch-up si attributs `catchup*` présents (rare, non standardisé) | Pas de distinction fiable live / film / série (à déduire de l'URL `/movie/`, `/series/` ou de l'extension) |
| Universel (tous fournisseurs, listes publiques type iptv-org) | Fichier parfois **énorme** (50–200 Mo) → à parser en streaming dans un worker, tout recharger pour rafraîchir |

### 1.2 API Xtream Codes (`player_api.php`)

API JSON paginée par type, identifiée par `serveur + username + password`.

| Endpoint (`action=`) | Apport |
|---|---|
| *(sans action)* | Infos compte : statut, **date d'expiration**, connexions max/actives, formats autorisés, fuseau serveur |
| `get_live_categories` / `get_live_streams` | Chaînes classées, logo, `epg_channel_id`, **`tv_archive` + `tv_archive_duration`** (catch-up) |
| `get_short_epg` / `get_simple_data_table` / `xmltv.php` | EPG par chaîne ou complet (XMLTV) |
| `get_vod_categories` / `get_vod_streams` | Films : affiche, note, **`added` (timestamp d'ajout)**, extension conteneur |
| `get_vod_info` | Synopsis, casting, réalisateur, durée, genre, **`tmdb_id`**, backdrop, trailer YouTube |
| `get_series_categories` / `get_series` / `get_series_info` | Séries **structurées** : saisons, épisodes, résumés, vignettes |
| `/timeshift/{user}/{pass}/{durée}/{AAAA-MM-JJ:HH-MM}/{id}.ts` | **Replay / reprise depuis le début** d'un programme passé |

URLs de lecture : `/live/u/p/{id}.m3u8|.ts`, `/movie/u/p/{id}.{ext}`, `/series/u/p/{id}.{ext}`.

### 1.3 Synthèse

| Fonctionnalité | M3U | Xtream |
|---|---|---|
| Chaînes live + catégories | ✅ | ✅ |
| EPG | ⚠️ si `url-tvg` ou EPG externe | ✅ natif + externe possible |
| Films avec métadonnées | ⚠️ nom + logo seulement → enrichissement TMDB obligatoire | ✅ (+ `tmdb_id` direct) |
| Séries saisons/épisodes | ⚠️ reconstruction heuristique | ✅ |
| « Fraîchement arrivé » | ⚠️ diff entre deux synchros | ✅ champ `added` |
| Replay / reprise début | ⚠️ attributs `catchup` (rare) | ✅ si `tv_archive=1` |
| Infos compte / expiration | ❌ | ✅ |
| Rafraîchissement incrémental | ❌ (re-téléchargement complet, mais `ETag`/`Last-Modified` possible) | ✅ par catégorie |
| Universalité | ✅ | ⚠️ fournisseurs compatibles Xtream |

**Conclusion** : Xtream est nettement plus riche. Le M3U sera un « mode dégradé » compensé par TMDB + EPG externe + heuristiques. L'architecture doit normaliser les deux dans **un modèle interne unique** (adaptateurs).

---

## 2. Faisabilité des fonctionnalités demandées

Légende : ✅ faisable · ⚠️ faisable avec limites/conditions · ❌ non faisable (ou non raisonnable)

| # | Fonctionnalité | Verdict | Commentaire |
|---|---|---|---|
| 1 | Profils multiples, enrôlement M3U/Xtream, N sources par profil | ✅ | 100 % local (pas de backend). |
| 2 | Bascule automatique sur une autre source si un lien casse | ✅ / ⚠️ | Au niveau **source** (health-check) : ✅. Au niveau **chaîne** : ⚠️ nécessite de faire correspondre la même chaîne entre sources (`tvg-id`, nom normalisé « TF1 FHD » ≈ « FR: TF1 HD »). Fiable à ~90 %. |
| 3 | Choix du profil au démarrage + « ne plus demander » + changement dans paramètres | ✅ | |
| 4 | Accueil type CANAL+ (catégories, continuer, nouveautés, séries…) | ✅ | Rails construits localement. |
| 5 | Top 10 / « À l'affiche » | ⚠️ | Le fournisseur ne donne aucune popularité → on croise **TMDB trending/popular (région FR)** avec le catalogue disponible. N'affiche que ce qui est réellement lisible. |
| 6 | Continuer la lecture | ✅ | Positions sauvegardées localement. |
| 7 | Recherche mosaïque + champ | ✅ | Index plein texte local (worker), tolérant aux accents/fautes. |
| 8 | Recherche vocale | ⚠️ | Web Speech API **non fiable dans la WebView Android** → plugin natif `SpeechRecognizer`. Fonctionne sur mobile et sur la plupart des télécommandes Android TV à micro. En navigateur : Chrome desktop uniquement. |
| 9 | TV : Maintenant / Ce soir / catégories / Programme TV | ✅ / ⚠️ | Dépend de la qualité de l'EPG. Sans EPG pour une chaîne : vignette = logo, pas de progression. |
| 10 | Chaînes & Apps (liste + contenu par chaîne) | ⚠️ | Liste : ✅. « Contenu par chaîne » : replay de la chaîne via catch-up (Xtream) ✅ ; regroupement VOD par chaîne d'origine (« Séries CANAL+ ») : seulement via `network`/`production_companies` TMDB → approximatif. |
| 11 | Mise à jour catalogue en arrière-plan régulière | ⚠️ | App ouverte : ✅ (worker + intervalle). App fermée : JS ne tourne pas → **WorkManager natif** (plugin Kotlin) pour télécharger/parser ou au minimum pré-télécharger les fichiers. Recommandé : synchro au lancement + périodique app ouverte en V1, WorkManager en V2. |
| 12 | Description programme / avancement sur chaînes | ✅ | Via EPG. |
| 13 | Lecteur plein écran avec toutes les actions | ✅ | Pause, ±10 s, seek, pistes audio/sous-titres, ratio, vitesse (VOD), infos, chaîne ±, mini-guide. |
| 14 | Plein écran paysage mobile | ✅ | `screen-orientation` + immersive mode. |
| 15 | Pause du direct / retour arrière | ⚠️ | Si le flux HLS expose une fenêtre DVR ou si catch-up dispo : ✅. Sinon timeshift **local** limité (buffer de quelques minutes en mémoire/disque côté natif) → V2. |
| 16 | Reprendre un programme depuis le début (appui long) | ⚠️ | **Uniquement** si la chaîne a le catch-up (`tv_archive` Xtream ou `catchup` M3U). Sinon action masquée. |
| 17 | Retour au direct | ✅ | |
| 18 | Cast TV (Chromecast) | ⚠️ | Plugin Google Cast natif. Limites fortes : le Default Media Receiver **exige CORS sur les flux HLS** et **ne lit pas le MPEG-TS brut** — beaucoup de fournisseurs IPTV ne passent pas. Un receiver custom (page HTTPS hébergée) améliore les choses mais nécessite un hébergement. → Bonus V2, « best effort ». |
| 19 | Qualité auto / manuelle | ⚠️ | Vraie ABR seulement si le flux est un HLS multi-variantes (rare en IPTV). **Astuce** : regrouper les déclinaisons d'une même chaîne (`SD/HD/FHD/4K/HEVC`) et les proposer comme « qualités » → utile aussi pour le fallback. |
| 20 | Enrichissement TMDB / EPG FR / autres API | ✅ | Voir §6. **Jeton TMDB saisi par l'utilisateur dans son profil**, jamais embarqué dans l'APK (attribution obligatoire). Sans jeton : l'app fonctionne avec les métadonnées fournisseur seules. |
| 21 | Image pour chaque vidéo / chaîne | ✅ / ⚠️ | Logo fournisseur → logo iptv-org → TMDB → **placeholder généré** (initiales + couleur). Jamais de case vide. Vignette « image du direct » à la CANAL+ : ❌ (pas de snapshot côté fournisseur) → on affiche l'image du programme EPG si fournie, sinon backdrop TMDB, sinon logo. |
| 22 | Légèreté / fluidité / cache | ✅ | Point central de l'architecture (§3.4). |
| 23 | Thèmes | ✅ | Variables CSS. |
| 24 | Internationalisation | ✅ | FR/EN au départ ; TMDB/EPG dans la langue choisie. |
| 25 | Téléchargement hors connexion | ⚠️ | VOD : possible (téléchargement natif du fichier) si le fournisseur l'autorise. Live : ❌. Hors périmètre V1. |
| 26 | Contrôle parental / PIN catégories adultes | ✅ | Ajout recommandé (catégorie « Adulte » visible dans vos captures). |
| 27 | Multi-écran / Multi-Live | ⚠️ | Techniquement possible (2–4 lecteurs) mais coûteux en décodage sur box TV et consomme N connexions fournisseur. V3 éventuelle. |
| 28 | Publication Play Store | ⚠️ | Google tolère les lecteurs IPTV **sans contenu ni promotion de contenu piraté** : aucune playlist préinstallée, captures avec contenus libres de droits. |

---

## 3. Stack technique recommandée

### 3.1 Le point clé : le lecteur vidéo

Lire de l'IPTV **dans une WebView** pose de vrais problèmes :

- Flux **MPEG-TS** (`.ts`) non lus nativement → `mpegts.js` via MSE (OK sur Chrome, coûteux en CPU sur petites box).
- Audio **AC3 / E-AC3** (très fréquent sur les chaînes FR) **non supporté par MSE** dans la WebView → vidéo sans son.
- HEVC/4K : décodage MSE aléatoire selon le SoC.
- Latence de zapping plus élevée, pas de tunneling vidéo, PiP plus compliqué.

**Décision recommandée : architecture hybride**

| Contexte | Moteur |
|---|---|
| Android (TV + mobile) | **Lecteur natif Media3/ExoPlayer** exposé par un plugin Capacitor maison (`NativePlayer`) : HLS, TS, AC3/E-AC3 (décodage ou passthrough HDMI), HEVC matériel, PiP, intégration Cast. |
| Navigateur (dev/test) | `hls.js` + `mpegts.js` derrière la **même interface TypeScript** `PlayerEngine`. |

Rendu : la vidéo native est dessinée dans une `SurfaceView` **sous une WebView transparente** ; tous les contrôles (barre, mini-guide, infos) restent en HTML → une seule UI pour les deux moteurs. (Plan B si problèmes sur certaines box : Activity native plein écran avec contrôles Compose.)

### 3.2 Stack

| Couche | Choix | Raison |
|---|---|---|
| Langage | **TypeScript** strict | |
| Build | **Vite** | Rapide, HMR, test immédiat dans le navigateur |
| UI | **React 19** (+ React Compiler) | Écosystème (navigation spatiale, virtualisation). *Alternative plus légère : SolidJS ; le vrai gain de perf vient surtout de la virtualisation et des images, pas du framework.* |
| Navigation D-pad (Android TV) | `@noriginmedia/norigin-spatial-navigation` | Gestion du focus télécommande |
| Virtualisation listes/grilles | `@tanstack/react-virtual` | Grilles de 50 000 items fluides |
| Routing | `@tanstack/react-router` | Typé, code-splitting |
| État UI | **Zustand** | Minimal |
| État données | **TanStack Query** | Cache mémoire, stale-while-revalidate |
| Stockage catalogue | **IndexedDB via Dexie** (dans un Web Worker) | Fonctionne navigateur + WebView, sans natif. *SQLite natif en V2 si volumétrie > 200k items.* |
| Recherche | **FlexSearch** (index persistant, worker) | Rapide, normalisation accents |
| Parsing | Workers : parser M3U **streaming** maison, `saxes` pour XMLTV (gz via `DecompressionStream`) | Jamais de parsing sur le thread UI |
| Communication worker | **Comlink** | |
| Préférences | `@capacitor/preferences` | |
| HTTP | `CapacitorHttp` natif (contourne CORS) ; **proxy Vite** en dev navigateur | Les fournisseurs n'envoient pas de CORS et sont souvent en HTTP |
| Cache images | **Service Worker + Cache Storage (LRU)** + tailles adaptées (TMDB `w185/w342/w780`) + `loading="lazy"` + `decoding="async"` | |
| i18n | **i18next** (+ ICU) ou **Paraglide** (compile-time, plus léger) | |
| Thèmes | Variables CSS + `data-theme` | |
| Styles | CSS Modules ou **Tailwind v4** | Zéro runtime CSS-in-JS |
| Shell natif | **Capacitor 7** (Android) | |
| Plugins natifs | `NativePlayer` (maison, Media3), `@capacitor-community/speech-recognition`, `@capacitor/screen-orientation`, `@capacitor-community/keep-awake`, `@capacitor/network`, `@capacitor/app`, Cast (maison ou communautaire), `SyncWorker` (WorkManager, V2) | |
| Tests | **Vitest** (parsers, normalisation, matching), **Playwright** (parcours web) | |
| Qualité | ESLint + Prettier, Husky | |

### 3.3 Arborescence cible

```
cybertv/
├─ apps/web/                 # app Vite/React (UI)
│  └─ src/
│     ├─ app/                # shell, routes, providers
│     ├─ features/           # home, search, tv, channels, player, profiles, settings
│     ├─ ui/                 # design system (Rail, Card, Tile, Tabs, Focusable…)
│     ├─ core/
│     │  ├─ sources/         # adaptateurs m3u / xtream → modèle interne
│     │  ├─ epg/             # XMLTV, matching chaînes
│     │  ├─ enrich/          # TMDB, iptv-org, TVmaze
│     │  ├─ db/              # Dexie schéma + repositories
│     │  ├─ sync/            # orchestrateur de synchro
│     │  ├─ player/          # PlayerEngine (native | hls.js | mpegts.js)
│     │  └─ i18n/, theme/
│     └─ workers/            # sync.worker.ts, search.worker.ts
├─ android/                  # projet Capacitor + plugins Kotlin
├─ packages/native-player/   # plugin Capacitor Media3
└─ docs/
```

### 3.4 Principes de performance (non négociables)

1. **Thread UI sacré** : parsing, synchro, indexation, matching EPG → workers.
2. **Tout est virtualisé** : rails horizontaux et grilles ; ≤ ~30 cartes montées à la fois.
3. **Démarrage depuis le cache** : l'UI s'affiche avec les données locales (< 1,5 s), la synchro se fait derrière (stale-while-revalidate).
4. **Images** : bonne taille, lazy, cache SW, placeholder couleur dominante, pas de re-décodage (pas d'images 1080p pour une carte 300 px).
5. **Animations** uniquement `transform`/`opacity` ; pas d'ombres/flous lourds sur Android TV (option « mode performance » qui coupe les effets).
6. **Code-splitting** par onglet ; bundle initial < 200 Ko gzip.
7. **EPG fenêtré** : on ne garde que J-7 → J+2 et seulement les chaînes présentes.
8. **Zapping** : réutilisation de l'instance lecteur, pré-résolution des URLs voisines, objectif < 1,5 s.

Budgets mesurés (box Android TV milieu de gamme type Chromecast Google TV / Mi Box S) :

| Métrique | Cible |
|---|---|
| Lancement à froid → accueil interactif (cache chaud) | < 2 s |
| Navigation entre onglets | < 150 ms |
| Scroll grille / rails | 60 fps (pas de frame > 32 ms) |
| Zapping chaîne → image | < 1,5 s |
| Mémoire JS | < 250 Mo |
| Synchro Xtream 30k VOD + 10k séries | < 60 s, sans gel UI |

---

## 4. Modèle de données (local)

```ts
Profile        { id, name, avatar, pin?, lang, theme, parental: { enabled, pin, hiddenGroups[] },
                 apiKeys: { tmdbToken? },   // stockage chiffré (Keystore), jamais dans le bundle/APK
                 createdAt }
Source         { id, profileId, type: 'm3u'|'xtream', label, priority, url | {server, user, pass},
                 epgUrls[], status: 'ok'|'degraded'|'down', lastSyncAt, lastError?, account?: { expiresAt, maxConn } }
Category       { id, sourceId, kind: 'live'|'vod'|'series', name, normalizedName, order, hidden }
Channel        { id, sourceId, extId, name, normalizedName, logo, categoryId, epgId?, catchupDays?,
                 qualityTag?: 'SD'|'HD'|'FHD'|'4K'|'HEVC', groupKey }   // groupKey = même chaîne toutes sources/qualités
Movie          { id, sourceId, extId, title, year?, poster?, backdrop?, plot?, rating?, durationSec?,
                 genres[], cast[], tmdbId?, addedAt, containerExt, groupKey }
Series         { id, sourceId, extId, title, poster?, backdrop?, plot?, tmdbId?, addedAt, groupKey }
Episode        { id, seriesId, season, episode, title, plot?, still?, durationSec?, extId, containerExt }
EpgProgram     { channelEpgId, start, end, title, subTitle?, desc?, category?, image?, season?, episode? }
WatchState     { profileId, itemType, itemId|groupKey, positionSec, durationSec, updatedAt, completed }
Favorite       { profileId, itemType, groupKey, order }
EnrichCache    { key, provider, payload, fetchedAt, ttl }
```

`groupKey` est la clé de voûte du **fallback multi-sources** et du **choix de qualité** : une chaîne/film logique → N flux physiques classés par (priorité source, qualité, santé).

---

## 5. Spécifications fonctionnelles

### 5.1 Démarrage & profils

1. **Splash** (logo, < 1 s) → si aucun profil : **onboarding**.
2. **Onboarding / enrôlement**
   - Choix : « Lien M3U » ou « Compte Xtream (serveur, identifiant, mot de passe) », + champ optionnel URL EPG.
   - Bouton « Tester » : vérifie la connexion, affiche nb de chaînes/films/séries détectés, expiration (Xtream).
   - Étape **« Enrichissement (recommandé) »** : champ jeton TMDB (lecture API v4) avec lien vers la création de compte TMDB, bouton « Tester », bouton « Passer ». Stocké chiffré dans le profil, modifiable dans *Paramètres > Profil > Services*. En dev uniquement, pré-remplissage possible depuis `.env.local` (variable exclue des builds de production).
   - Possibilité d'ajouter d'autres sources au même profil (ordre de priorité par glisser/déposer ou flèches sur TV).
   - Saisie sur TV : clavier à l'écran + **saisie depuis le téléphone par QR code** (V2 : mini serveur local ou page web qui renvoie la config) — fortement recommandé, taper une URL M3U à la télécommande est pénible.
   - Import/export de profil (fichier JSON chiffré par mot de passe optionnel).
3. **Sélection de profil** au démarrage (avatars, style plateforme) avec case « Ne plus demander » → profil par défaut. Modifiable dans *Paramètres > Profils*. PIN optionnel par profil.
4. Première synchro : écran de progression (chaînes → films → séries → EPG → enrichissement) ; l'utilisateur peut entrer dans l'app dès que les chaînes sont prêtes.

### 5.2 Navigation globale

- **Android TV / grand écran** : barre de navigation en haut (Accueil · Recherche · TV · Replay · Mes vidéos) + avatar profil à droite. Retour = remonter d'un niveau, puis focus sur la barre, puis confirmation de sortie.
- **Mobile** : barre d'onglets en bas (Accueil · Recherche · En direct · Replay · Mes vidéos).
- Focus visible et généreux sur TV (agrandissement 1.08 + liseré accent), mémorisation du focus par rail.

### 5.3 Accueil (VOD & séries, pas de TV)

Héros en haut (carrousel 5–6 éléments, backdrop + **logo titre TMDB** (fallback : titre en texte) + bouton Lecture / Infos), puis rails :

| Rail | Source de données |
|---|---|
| Tuiles catégories (Cinéma, Séries, Jeunesse, Docs…) | Mapping des catégories fournisseur → univers internes (règles mots-clés + éditables) |
| Continuer la lecture (avec ×, barre de progression) | `WatchState` non terminé |
| Épisode suivant | Séries en cours |
| Ciné fraîchement arrivé | Films triés par `addedAt` (Xtream) / date de première apparition (M3U) |
| Top 10 du moment (gros chiffres) | TMDB trending week ∩ catalogue |
| À l'affiche / Populaires | TMDB now_playing / popular ∩ catalogue |
| Nouvelles séries | Séries par `addedAt` |
| Films à voir / Les mieux notés | `rating` ≥ 7, TMDB vote_average |
| Par genre (Action, Comédie, Animation…) | Genres TMDB |
| Ma liste | Favoris VOD |

- Rails « Tous » → grille virtualisée filtrable (genre, année, note, tri).
- **Fiche détail** (film/série) : backdrop, titre, année, durée, note, genres, synopsis, casting, bande-annonce (YouTube si dispo), boutons Lecture / Reprendre / Ma liste ; séries : onglets **Épisodes · Bonus · À voir aussi** avec sélecteur de saison (cf. capture 6) et état vu/en cours par épisode.

### 5.4 Recherche

- Champ en haut + bouton **micro** ; résultats en **mosaïque** mis à jour à la frappe (debounce 150 ms).
- Sur TV : clavier à l'écran compact + suggestions.
- Résultats groupés : Chaînes · Programmes TV (EPG en cours/à venir) · Films · Séries · Personnes (via casting).
- Recherche insensible aux accents/casse, tolérance fautes légères, filtres par type.
- Historique des recherches récentes par profil.

### 5.5 TV en direct

- **Onglets** : **Maintenant** · **Ce soir** (programmes 20h50–23h, configurable) + bouton **Programme TV**.
- **Sous-onglets catégories** : Favoris · Toutes les chaînes · Sport · Cinéma · Jeunesse · Infos · Séries · Découverte · Divertissement · Musique · Adulte (masqué/PIN) — mappés depuis les groupes fournisseur, personnalisables (renommer, masquer, réordonner).
- **Carte chaîne** : image du programme (ou backdrop TMDB ou logo), logo chaîne en incrustation, titre programme, sous-titre (épisode/compétition), **barre de progression**, icône « reprendre au début » si catch-up.
- **Actions** :
  - OK/tap → lecture live.
  - **Appui long** → menu : Regarder depuis le début · Programme de la chaîne · Ajouter aux favoris · Choisir la source/qualité.
- **Programme TV (guide EPG)** : grille chaînes × temps virtualisée dans les deux axes, ligne « maintenant », navigation jour par jour (J-7 → J+2), programmes passés lisibles si catch-up, fiche programme (titre, horaire, description, genre, image).
- **Favoris** : ordre personnalisé, numérotation pour zapping par chiffres de la télécommande.

### 5.6 Chaînes

- Grille de logos par bouquet/groupe (cf. capture 3).
- **Page chaîne** : en direct maintenant (gros bouton), à suivre, **replay** des 7 derniers jours (si catch-up), et, si pertinent, VOD liée (séries/films dont TMDB `networks`/sociétés de prod correspond — approximation signalée).

### 5.7 Mes vidéos

- Continuer la lecture, Ma liste, Historique, (V2) Téléchargements.

### 5.8 Lecteur

**Commun** : plein écran, contrôles masqués après 4 s d'inactivité, réapparition à toute touche/tap.

| Zone | Contenu |
|---|---|
| Haut | Logo chaîne / titre programme ou film, sous-titre, bouton fermer, bouton PiP |
| Bas | -10 s · Play/Pause · +10 s · badge **LIVE** (rouge si au direct, gris si en différé → appui = retour au direct) · barre de progression (live : début/fin du programme EPG) · horaires |
| Actions | Toutes les chaînes (mini-guide latéral) · Revoir / À suivre · Sous-titres & audio · Qualité · Infos · Format d'image (fit/fill/zoom) · Vitesse (VOD) |

**Live** :
- Zapping : haut/bas (TV) ou glisser vertical (mobile), chaîne précédente (touche dédiée), saisie numéro.
- Bandeau info au zapping (programme en cours + suivant).
- **Pause/retour arrière** si fenêtre DVR/catch-up ; **Depuis le début** ; **Retour au direct**.
- **Fallback automatique** : erreur réseau / buffering > 8 s → flux suivant du même `groupKey` (autre qualité ou autre source), toast discret « Source de secours utilisée ».

**VOD** : reprise auto (« Reprendre à 34:12 / Recommencer »), épisode suivant auto avec compte à rebours, sauvegarde position toutes les 10 s.

**Qualité** : Auto (ABR HLS si multi-variantes, sinon meilleure qualité saine du groupe) / choix manuel parmi variantes et déclinaisons SD/HD/FHD/4K.

**Mobile** : rotation forcée paysage en plein écran, mode immersif, gestes (double-tap ±10 s, glisser vertical luminosité/volume côté gauche/droit), **PiP** Android, maintien écran allumé.

**Cast (V2)** : bouton Cast si appareil détecté ; si le flux n'est pas castable (TS, sans CORS), message explicite.

### 5.9 Synchronisation

- Déclencheurs : lancement (si dernière synchro > X h), intervalle app ouverte (défaut : chaînes 12 h, VOD/séries 24 h, EPG 6 h), manuel (« Actualiser »), WorkManager (V2, app fermée, Wi-Fi uniquement option).
- Xtream : par catégorie, diff (ajout/suppression/modif) → écriture batchée Dexie.
- M3U : requête conditionnelle (`ETag`/`If-Modified-Since`), parsing streaming, hash par entrée pour diff.
- Health-check sources : ping léger (Xtream `player_api` / HEAD M3U) → statut OK/dégradé/HS affiché dans Paramètres.
- Enrichissement TMDB **paresseux et priorisé** : d'abord ce qui est visible (rails d'accueil), puis en tâche de fond avec rate-limit (≤ 40 req/10 s), cache 30 j.

### 5.10 Paramètres

Profils · Sources (ajout, priorité, test, statut, expiration) · EPG (URLs, décalage horaire) · Catégories (masquer/renommer/réordonner/mapper) · Lecteur (moteur, qualité par défaut, buffer, décodage logiciel/matériel, langue audio/sous-titres préférées, passthrough audio) · Apparence (thème, mode performance) · Langue · Contrôle parental · Synchronisation · Cache (taille, vider) · À propos / mentions TMDB.

### 5.11 Thèmes

- **Nuit** (défaut, noir #0d0d0d, accent rouge), **OLED** (noir pur), **Clair**, **Bleu nuit**, + couleur d'accent personnalisable. Tokens CSS (`--bg`, `--surface`, `--text`, `--accent`, `--focus-ring`, radius, spacing).

### 5.12 Internationalisation

- FR + EN en V1 (ES/DE/IT/AR faciles ensuite ; RTL prévu dans le CSS via propriétés logiques).
- Dates/heures via `Intl` ; langue TMDB et EPG alignée sur la langue du profil.

---

## 6. API externes gratuites

| API | Usage | Remarques |
|---|---|---|
| **TMDB** | Affiches, backdrops, **logos titres** (`/images` → `logos`, PNG/SVG transparents, filtrés `include_image_language=fr,en,null`), synopsis, casting, trending/top/now_playing, trailers, `networks` + logos de chaînes/networks | Jeton gratuit **saisi par l'utilisateur dans son profil** ; attribution obligatoire ; matching par `tmdb_id` (Xtream) ou titre+année nettoyés (« FR - Dune (2021) 4K » → « Dune », 2021) |
| **xmltvfr.fr** | EPG XMLTV des chaînes françaises (TNT, câble/sat), avec images | Gratuit, mis à jour quotidiennement |
| **iptv-org/epg** & **iptv-org/database** | EPG internationaux, base de chaînes (id, logos, pays, catégories) | Matching `tvg-id`, logos de secours |
| **TVmaze** | Séries (épisodes, horaires), sans clé | Complément/fallback TMDB pour séries |
| **Fanart.tv** | Clearart, backgrounds supplémentaires (fallback si TMDB n'a pas de logo) | Clé gratuite, optionnel, V2 |
| **OMDb** | Notes IMDb/Rotten Tomatoes | Clé gratuite limitée, optionnel |
| **Trakt** | Sync « vu » / watchlist multi-appareils | OAuth, V3 optionnel |
| **YouTube (embed)** | Bandes-annonces | Lien direct depuis TMDB `videos` |

---

## 7. Plan de développement

Hypothèse : 1 dev + assistance IA. Chaque phase est **testable dans le navigateur** ; Android dès la phase 0.

| Phase | Contenu | Livrable / critère de fin | Estim. |
|---|---|---|---|
| **P0 — Fondations** | Monorepo, Vite + React + TS, Capacitor Android, ESLint/Prettier/Vitest, proxy de dev CORS, design system (tokens, thèmes, Card, Rail, Tabs, Focusable), i18n FR/EN, navigation spatiale, shell (barre haute TV / barre basse mobile) | App vide navigable au D-pad dans le navigateur et sur Android TV émulateur | 1 sem. |
| **P1 — Sources & données** | Schéma Dexie, adaptateurs **Xtream** + **M3U streaming** en worker, normalisation, `groupKey`, profils + onboarding + test de source, sélection profil au démarrage, synchro initiale avec progression | Import d'une vraie source 50k entrées sans gel UI ; tests unitaires parsers | 1,5 sem. |
| **P2 — TV & lecteur web** | Onglet TV (Maintenant, catégories, favoris), page Chaînes, `PlayerEngine` web (hls.js/mpegts.js), lecteur plein écran + zapping + mini-guide | Regarder et zapper des chaînes dans le navigateur | 1,5 sem. |
| **P3 — EPG** | Parser XMLTV streaming (gz), EPG Xtream, matching chaînes (id, nom normalisé, iptv-org), cartes avec programme + progression, « Ce soir », **Programme TV** (grille 2D virtualisée), fiche programme | Guide fluide sur 300 chaînes × 3 jours | 1,5 sem. |
| **P4 — VOD & séries** | Accueil (héros + rails), enrichissement TMDB (file prioritaire, cache), Top 10/À l'affiche, grilles « Tous », fiches film/série/épisodes, continuer la lecture, reprise, épisode suivant, Ma liste | Accueil complet type plateforme | 2 sem. |
| **P5 — Recherche** | Index FlexSearch en worker, mosaïque, filtres, historique ; recherche vocale (plugin natif) | Résultats < 100 ms sur 100k items | 0,5 sem. |
| **P6 — Lecteur natif Android** | Plugin Capacitor **Media3** (surface sous WebView transparente), pistes audio/ST, qualité, AC3/HEVC, PiP, paysage/immersif, gestes mobile, keep-awake | Lecture TS + AC3 OK sur box TV et mobile | 2 sem. |
| **P7 — Différé & résilience** | Catch-up/timeshift Xtream + M3U `catchup`, « depuis le début » (appui long), pause/retour arrière, retour au direct, **fallback multi-sources/qualités**, health-check | Panne simulée d'une source → bascule transparente | 1,5 sem. |
| **P8 — Android TV finition** | Manifest Leanback, bannière, touches télécommande (chiffres, chaîne ±, info, guide), clavier TV, mode performance, contrôle parental, paramètres complets | Utilisable 100 % à la télécommande | 1 sem. |
| **P9 — Perf & qualité** | Profilage sur box bas de gamme, budgets §3.4, cache images SW, code-splitting, Playwright, crash/erreurs (journal local) | Budgets atteints | 1 sem. |
| **V2** | WorkManager (synchro app fermée), Cast, QR-code d'enrôlement depuis le téléphone, timeshift local, téléchargements VOD, SQLite natif si besoin | | — |
| **V3** | Trakt, Multi-Live, widgets/chaînes Android TV « Watch Next » | | — |

**Total V1 ≈ 13–14 semaines.**

### Jalons de démonstration

1. **Fin P2** : on ajoute une source et on regarde la TV dans le navigateur.
2. **Fin P4** : l'expérience « plateforme » (accueil, fiches, reprise) est complète en web.
3. **Fin P7** : APK Android TV/mobile exploitable au quotidien.

---

## 8. Risques & points ouverts

| Risque | Mitigation |
|---|---|
| WebView ancienne sur box Android TV bon marché (Android 7–9 non mises à jour) | `minSdk` 24, polyfills ciblés, test sur vraie box, Media3 côté natif rend la vidéo indépendante de la WebView |
| Fournisseurs hétérogènes (formats d'URL, EPG décalés, noms sales) | Couche de normalisation testée sur un corpus d'exemples anonymisés ; réglage décalage EPG par source |
| Limite de connexions simultanées fournisseur (souvent 1) | Ne jamais ouvrir 2 flux du même compte (pas de préchargement réel de flux, pas de multi-live sur 1 compte) |
| Volumétrie (100k+ VOD) dans IndexedDB | Écritures batchées, index ciblés ; migration SQLite natif prévue |
| Matching TMDB erroné | Score de confiance ; correction manuelle « Ce n'est pas le bon film » |
| Politique Play Store | Pas de contenu préchargé, mention « lecteur uniquement » |
| Sécurité des identifiants Xtream | Stockage chiffré (Android Keystore via plugin secure storage) ; jamais dans les logs |

**Décisions à valider**

1. Lecteur natif Media3 (recommandé) vs 100 % web (plus simple, mais AC3/TS/perf problématiques).
2. React (écosystème) vs SolidJS (légèreté).
3. ~~Clé TMDB embarquée ou saisie par l'utilisateur.~~ → **Décidé : saisie dans le profil, jamais dans l'APK.**
4. Nom définitif de l'app (provisoire : CyberTV) et charte (s'inspirer de l'ergonomie CANAL+ sans reprendre logo, couleurs exactes ni typographie propriétaire).

---

## 9. État d'avancement (V1 — 21/11/2026)

### Écarts assumés par rapport au §3

| Prévu | Réalisé | Raison |
|---|---|---|
| Monorepo `apps/web` + `packages/native-player` | Projet unique (`src/`, `android/`), plugin dans l'app Android | Moins de configuration, un seul build |
| norigin-spatial-navigation | Navigation D-pad maison (`src/ui/spatial.ts`, ~250 lignes) | Fonctionne avec la virtualisation, gère l'appui long OK |
| TanStack Router / Query | Pile de routes Zustand + hook `useAsync` | Plus léger, gestion du « retour » télécommande simple |
| FlexSearch | Index maison dans un worker (`src/core/search.ts`) | < 20 ms sur 100k titres, zéro dépendance |
| Service Worker pour les images | Android : proxy natif `/img` avec cache disque LRU (400 Mo, TMDB inclus). Web : Service Worker `public/sw.js` (cache-first, 2 500 images) | Les Service Workers sont peu fiables dans la WebView Android |
| Plugin natif en Kotlin | Java | Pas de plugin Kotlin à configurer dans Gradle |

### Fait et testé
- Navigateur : onboarding, sources Xtream + M3U, synchro, EPG, TMDB (affiches, logos, synopsis, casting, trailers), accueil, TV (Maintenant / Ce soir / catégories / favoris), guide, chaînes + replay, fiches film/série, recherche, lecteur (direct, différé, depuis le début, retour au direct, reprise VOD, fallback), mobile.
- Android (émulateur Pixel 9, API 36) : proxy natif, Keystore, synchro, lecteur Media3 sous la WebView, HLS adaptatif (pistes vidéo détectées), passage en paysage + immersif, contrôles HTML par-dessus la vidéo, retour matériel.

### Langues, pays et classement (V1.1)
- Profil : pays, langue audio préférée + seconde, langue de sous-titres préférée + seconde, affichage des sous-titres (jamais / si VO / toujours).
- Langues détectées à la synchro (`src/core/util/lang.ts`) : préfixes fournisseur (`FR:`, `|EN|`), tags `VF`/`VOSTFR`/`MULTI`, nom de catégorie, `tvg-language`/`tvg-country`, suffixe d'id EPG (`tf1.fr`). Après lecture d'un film, les vraies pistes audio/sous-titres remplacent les tags.
- Accueil, grilles, recherche et choix de la version lue : contenu dans la langue préférée d'abord, puis seconde langue, puis sous-titré, puis non précisé, puis le reste.
- Onglet TV (`src/core/channelRank.ts`) : classement national de référence (audiences annuelles, aucune API gratuite d'audience en temps réel) × langue × pays × programme en cours (sport en direct, grands événements, JT, film en prime). Filtre « Mes langues » activé par défaut.
- Fiche : drapeaux audio / sous-titres, bande-annonce YouTube muette en fond après 3,5 s (désactivable dans Lecteur, coupée en mode performance).

### Mise à jour automatique (V1.2)
- `update.json` publié avec chaque release (`scripts/release.mjs`) : version web, `versionCode` de l'APK, `minVersionCode` requis.
- Contenu web : ZIP vérifié (SHA-256), décompressé dans `files/web/<version>` et déclaré comme `serverBasePath` Capacitor (ignoré automatiquement après installation d'un nouvel APK). Retour au contenu de l'APK après 2 démarrages sans confirmation `updateBootOk`.
- APK : téléchargé dans le cache puis remis à l'installeur Android (`REQUEST_INSTALL_PACKAGES` + FileProvider). Une installation 100 % silencieuse est impossible hors Play Store / appareil géré.

### Enrôlement par QR code (V1.3)
- TV : `EnrollServer.java` ouvre un serveur HTTP sur l'adresse du réseau local (port aléatoire, jeton aléatoire de 144 bits, 256 Ko max, arrêt à la fermeture de l'écran ou après 15 min). Le QR code contient `http://<ip-tv>:<port>/e/<jeton>`.
- Téléphone sans l'app : la page `public/enroll.html` (servie par la TV) envoie un formulaire (sources Xtream/M3U, serveurs de secours, EPG, jeton TMDB).
- Téléphone avec l'app : la page propose « Ouvrir dans l'app CyberIPTV » (`intent://enroll?target=…`, Android/Chrome). L'app ouvre « Envoyer à une TV » et transmet les sources choisies (mots de passe compris), le jeton TMDB et les préférences, uniquement vers une adresse de réseau privé.
- La TV affiche un résumé et demande confirmation avant tout import. Tout passe sur le réseau local, en HTTP (pas de TLS possible sans certificat) : à n'utiliser que sur un Wi-Fi de confiance.
- Web : `dev-server/enroll.ts` reproduit le serveur, le parcours complet se teste dans le navigateur.
- Limite : sans domaine vérifié (Android App Links), le QR ne peut pas ouvrir l'app directement ; il faut toucher « Ouvrir dans l'app ».

### Sous-titres OpenSubtitles (V1.3)
- Réglages → Services : clé API gratuite (obligatoire pour télécharger) et compte optionnel (20 téléchargements par jour au lieu de 5). Profil → Sous-titres : « Récupérer des sous-titres sur OpenSubtitles », activé par défaut.
- Recherche automatique en VOD quand le profil veut des sous-titres et que le flux n'en a pas dans ses langues. Recherche par id TMDB (film, ou série + saison + épisode) avec le hash OpenSubtitles du fichier (2 requêtes de 64 Ko) : les sous-titres calés sur ce fichier précis passent en tête.
- Synchro : affichage HTML piloté par la position de lecture (interpolée entre les mises à jour natives de 500 ms), décalage réglable de ±0,5 s et retenu par vidéo, choix entre plusieurs versions dans le panneau du lecteur. Les fichiers téléchargés restent en cache (quota quotidien faible).

### Préchargement en arrière-plan (V1.4, approche 1)
- `PrefetchWorker.java` (WorkManager) : tâche périodique (moitié de l'intervalle de synchro, 3 h minimum), en Wi-Fi/Ethernet par défaut, batterie et stockage non faibles. Android conserve la planification après un redémarrage.
- Le plan (URL M3U, réponses API Xtream, guides XMLTV) est construit par la synchro et stocké chiffré (Keystore), car il contient les identifiants Xtream. Les fichiers bruts vont dans `cache/prefetch/`, avec des requêtes conditionnelles (ETag / Last-Modified, réponse 304 = rien à retélécharger).
- À l'ouverture : si un préchargement est plus récent que la dernière synchro, la synchro démarre aussitôt, sans indicateur. Elle lit les copies locales via `LocalProxy /cached` (uniquement si elles sont plus récentes que les données en base, sinon réseau). Il ne reste que l'analyse.
- Réglages → Synchronisation : activer/désactiver, Wi-Fi uniquement, état du dernier préchargement, « Précharger maintenant ».

### Affichage instantané
- Cache « dernier résultat » par écran (accueil, grilles, TV, chaînes, guide, mes vidéos) : un onglet revisité s'affiche aussitôt puis se met à jour.
- Instantané de l'accueil enregistré (au plus toutes les 20 s) et rechargé avant le premier affichage : l'accueil est visible tout de suite au lancement.
- Index léger du catalogue en mémoire (sans résumés ni castings), partagé par les grilles et les rails par genre. Avec 30 000 films : réouverture d'une grille en 83 ms contre environ 600 ms auparavant.

### Métadonnées enrichies (V1.5)
- TMDB v2 (`ENRICH_V = 2`, mise à niveau en tâche de fond des titres déjà enrichis) : classification d'âge du pays (FR, puis US/GB/DE, normalisée en âge minimum), saga (collection), id IMDb, 20 recommandations, casting avec photos.
- Notes IMDb : fichier officiel `title.ratings.tsv.gz` (environ 9 Mo, usage personnel non commercial), lu en flux, seuls les titres du catalogue sont gardés. Badge sur toutes les affiches.
- Fiche : âge, IMDb, rail Saga (volets disponibles), Casting, Recommandés (uniquement les titres disponibles, sinon même genre). Fiche acteur : biographie et ses films ou séries disponibles.
- Contrôle parental par âge (Réglages → Contrôle parental) : code demandé pour ouvrir ou lire un titre classé au-dessus.
- iptv-org (base CC0, hebdomadaire, incluse dans le préchargement) : logo manquant ou de secours, langues et pays officiels, catégorie, appliqués après chaque synchro.
- Logos sombres : luminosité mesurée une fois (canvas, via le proxy pour CORS) ; en thème sombre, silhouette blanche ou éclaircissement. Agent utilisateur dédié pour Wikimedia (évite les 429).
- Scores en direct : JSON public d'ESPN (non officiel, sans clé), football et rugby. Le score est rapproché du programme TV par les noms d'équipes (alias français) et l'horaire, et affiché sur la carte de la chaîne et dans le lecteur.

### Robustesse et recherche (V1.5)
- Synchro : une liste illisible ou en échec (films, séries) n'est plus traitée comme « liste vide ». La source passe en « Dégradée » et garde son catalogue. Aucune suppression si la nouvelle liste est vide ou chute de plus de 70 % sur un gros catalogue. Une copie préchargée illisible est ignorée au profit du réseau. Une resynchro complète unique a lieu après la mise à jour.
- Recherche : l'index existant répond tout de suite, et la reconstruction se fait par morceaux en arrière-plan puis bascule d'un coup. L'index est enregistré pour un démarrage à froid immédiat. Le programme TV a son propre index et s'affiche en second. Les résultats sont mémorisés par requête. Avec 31 000 titres : 9 à 31 ms par frappe.
- Écrans : un garde-fou affiche « Réessayer » au lieu d'un écran noir en cas d'erreur d'affichage.

### Replay gratuit et flux officiels (V1.6)
- L'onglet « Replay » remplace l'onglet « Chaînes ». La page d'une chaîne reste accessible depuis le direct et le guide.
- Il présente le replay gratuit d'ARTE et de france.tv, lu depuis leurs services publics :
  - ARTE : API arte.tv (pages, collections, configuration du lecteur), HLS jusqu'en 1080p, sans DRM ;
  - france.tv : API des applis mobiles (pages de France 2, 3, 4 et 5, programmes) et service vidéo des lecteurs, interrogé comme un appareil iOS pour obtenir du HLS sans DRM, avec un jeton Akamai.
- L'écran comprend une bannière, un filtre Tout / ARTE / france.tv, les directs officiels, « Continuer la lecture » et des rails par thème. Les séries ont une page avec leurs saisons. Le catalogue est gardé 3 h.
- Lecture et reprise : type `replay`, avec reprise dans « Continuer la lecture ». La limite d'âge parentale s'applique selon la classification de la chaîne.
- Flux officiels en priorité pour France 2, France 3, France 4, France 5, franceinfo et Arte. La chaîne de la source est reconnue par son nom ou par son identifiant iptv-org. Le flux de la chaîne est essayé en premier (1080p), puis la source prend le relais. La résolution du flux est limitée à 4 s et mise en cache 30 min. Le réglage se trouve dans le profil (activé par défaut).
- Les CDN de france.tv refusent l'agent VLC : un agent navigateur est envoyé pour `*.ftven.fr` (lecteur Android, proxy de développement et de la version ordinateur).
- Limites :
  - beaucoup de vidéos ne sont visibles que depuis la France (ARTE : surtout l'Europe) ;
  - TF1+, M6+ et Canal+ ne sont pas intégrables (compte obligatoire et DRM) ;
  - ces API ne sont pas documentées publiquement et peuvent changer.

### Plus de replay, Trakt et pause du direct (V1.7)
- Replay : nouvelles pages LCP et Public Sénat (france.tv) et catalogue jeunesse Okoo (`apps/categories/enfants`), avec un filtre « Jeunesse (Okoo) ». Les éléments sont marqués `kids` pour un futur mode enfant. Le direct officiel LCP-Public Sénat (canal 13) s'ajoute aux chaînes prioritaires.
- TV5MONDE+ n'est pas intégré : le service n'est pas proposé en France (réponse 403).
- Dailymotion n'est pas utilisé pour LCP et Public Sénat : leurs vidéos y sont réservées au lecteur de leur site.
- Trakt :
  - mise en place : l'utilisateur crée son application gratuite, saisit son Client ID et son Client Secret dans Paramètres › Services (stockage sécurisé), puis relie son compte avec un code sur trakt.tv/activate (device flow, utilisable sur TV) ;
  - accueil : rails « Pour vous » (recommandations films et séries), « Ma watchlist Trakt » et listes personnelles (6 au plus), limités aux titres présents dans les sources (correspondance TMDB) et gardés 1 h ;
  - lecteur : scrobble start/pause/stop des films et épisodes ; Trakt marque le titre vu au-delà de 80 %.
- Pause et retour arrière sur le direct (tampon local) :
  - un enregistreur dans le proxy local (`Timeshift.java` sur Android, `dev-server/timeshift.ts` pour l'ordinateur et le développement) suit les playlists HLS du direct : meilleure variante jusqu'en 1080p et piste audio par défaut ;
  - il télécharge chaque segment sur disque (clés AES-128 comprises) et sert une playlist locale qui couvre toute la fenêtre (30 ou 60 min, réglable, désactivable) ;
  - les segments sont repérés par leur numéro de séquence, ce qui gère les URL changeantes des flux avec publicité et les remises à zéro ;
  - une session est réutilisée pour la même URL ; deux au plus ; arrêt après 2 min sans requête ; place disque libre surveillée sur Android ;
  - le lecteur s'en sert pour la pause, -10/+10 s, la barre de temps et le bouton « Direct ». La distance naturelle du lecteur au direct est mesurée pour l'indicateur « Différé de… ». Le catch-up du fournisseur prend le relais au-delà de la fenêtre ;
  - Xtream : avec le tampon actif, la sortie m3u8 est demandée. Non disponible sur iOS ni pour les flux MPEG-TS seuls.

### Commande vocale (V1.8, Android TV et téléphone)
- Déclencheurs :
  - la touche Recherche / Assistant vocal de la télécommande (`KEYCODE_SEARCH`, `KEYCODE_VOICE_ASSIST`), interceptée par `MainActivity` et transmise par l'événement `voiceKey` ;
  - un bouton micro dans la barre du haut (TV et mobile).
  - Les télécommandes dont le bouton micro ouvre Google Assistant au niveau du système ne l'envoient jamais aux applis : il reste le bouton de l'app.
- Reconnaissance : reconnaisseur du système (`RecognizerIntent`, sans permission micro pour l'app), jusqu'à 5 transcriptions essayées dans l'ordre.
- Interprétation locale (`src/core/voice/parse.ts`), en français et en anglais :
  - onglets (« accueil », « en direct », « replay », « mes vidéos », « paramètres ») ;
  - « recherche X » ;
  - « mets / lance / regarde X » : chaîne au nom exact, sinon meilleur titre ;
  - « la chaîne 5 », « le film X », « la série X » ;
  - dans le lecteur : pause, reprise, recul / avance de N secondes ou minutes, retour au direct, chaîne suivante / précédente, arrêt ;
  - les nombres en toutes lettres sont convertis ; « canal plus » privilégie les noms écrits avec un « + ».
- Exécution (`src/ui/voice/run.ts`) : correspondance par l'index de recherche (chaînes, films, séries). Un film reprend là où il s'était arrêté, une série ouvre sa fiche. Si rien ne correspond, l'écran de recherche s'ouvre. Une bulle affiche ce qui a été compris et l'action faite.

### Correctifs constatés sur téléphone avec un vrai abonnement Xtream (V1.9)
- **Affiches** : 85 % des affiches du fournisseur sont des URL TMDB `w600_and_h900_bestv2`. Le redimensionnement remplaçait seulement « w600 » et produisait une adresse invalide. Le segment de taille est désormais remplacé en entier.
- **Ordre des chaînes** : le bonus « programme en cours » (+70 pour un match en direct) faisait passer L'Équipe 21 ou RMC devant TF1. Il est réduit (+6 au plus) et ne départage que des chaînes d'audience proche.
- **Noms de chaînes** : les « / » et « // » du fournisseur sont retirés, aussi dans les noms déjà enregistrés (réparation unique).
- **Programmes manquants** : le fournisseur ne donne un identifiant de guide qu'à certaines versions d'une chaîne (pas à « TF1 UHD/4K »). Les autres versions le prennent d'une version sœur ou de leur identifiant iptv-org, après chaque synchro du guide et une fois au lancement.
- **Programme TV** :
  - il ouvrait rarement : pendant la synchro du guide, l'écran relançait toutes les 3 s une requête de plus de 3 s sur téléphone, dont le résultat était chaque fois jeté ;
  - les écrans n'ont plus qu'une requête à la fois, avec au plus une relance ensuite, et un résultat plus lent n'est plus perdu ; le guide n'est rafraîchi que toutes les 20 s pendant la synchro ;
  - le guide reprend la liste et l'ordre de la catégorie sélectionnée dans « En direct » (chaînes sans programme comprises) et charge les programmes chaîne par chaîne, par l'index `[epgId+start]` : 40 d'abord, puis par paquets ;
  - mesures sur le téléphone : 0,4 à 0,5 s, contre plusieurs secondes ou jamais avant.
- **Sous-catégories** : puces de genre dans Cinéma et Séries (Action, Comédie, Drame, Thriller & policier…), à partir des genres TMDB et des noms de catégories du fournisseur (« COMEDIE [FR] », « KOMEDIE [NL] »…).
- **Fiches séries** : épisodes de gauche à droite, avec défilement jusqu'au prochain épisode à voir. Les titres d'épisodes sont nettoyés (« Show (2024) - S01E01 - Titre » → « Titre »).
- **Barre d'état du téléphone** : masquée par-dessus le contenu qui défile.
- **Tampon du direct et abonnements à une seule connexion** :
  - l'enregistrement continuait 2 min après la fermeture du lecteur et occupait la connexion (le fournisseur refusait ensuite avec 509 ou 407) ;
  - il n'y a plus qu'un enregistrement à la fois ; il s'arrête à la fermeture du lecteur (`/tsh/stop`) ou dès qu'un autre type de flux est lu ;
  - en cas de refus, l'enregistreur attend de plus en plus longtemps puis abandonne ; au démarrage, il réessaie quelques secondes le temps que la connexion précédente soit libérée.

### YouTube, guide et confort (V1.10)
- **YouTube dans Replay** : rails Documentaires, Actu, Sport, Humour, Médias et Radio, à partir des flux RSS publics des chaînes (sans clé, 15 dernières vidéos par chaîne, Shorts exclus, 8 vidéos par chaîne au plus et 30 par rail, les plus récentes d'abord).
  - Chaînes françaises si l'app est en français (ARTE, France Culture, L'Équipe, RMC Sport, CANAL+ Sport, BFMTV, franceinfo, FRANCE 24, RTL, France Inter, Europe 1, NRJ, Montreux Comedy, Jamel Comedy Club, Palmashow, Norman, Cyprien, Brut, Konbini, Le Monde, Blast).
  - Sinon, chaînes britanniques (pays GB ou IE) ou américaines (autres pays).
  - Lecture dans le lecteur intégré de YouTube (youtube-nocookie), plein écran, en paysage sur téléphone, avec un bouton « Ouvrir dans YouTube » (application ou site).
  - Filtre « YouTube » ; dans « Tout », les rails YouTube sont intercalés.
- **Programme TV** : le guide national (xmltvfr, 7 jours) est lu avant celui du fournisseur, qui s'arrêtait après quelques heures pour M6, ARTE, W9, TFX… Il est rafraîchi seul toutes les 6 h, et les identifiants de guide manquants sont réparés après chaque synchro des chaînes.
- **Direct** : la version Full HD d'une chaîne passe avant la 4K/UHD (trop lourde sur téléphone, souvent instable chez les fournisseurs).
  - Le tampon du direct est prêt dès le premier segment, son démarrage ne bloque plus les autres requêtes, et il patiente jusqu'à ~15 s si le fournisseur considère encore le flux précédent comme actif (abonnements à une connexion, réponse 407).
- **Logos de chaînes** contenus dans leur cadre, quelle que soit leur forme.
- **Téléphones** : mode portrait verrouillé en dehors de la lecture ; la barre d'état est masquée au-dessus du contenu des onglets.

### Démarrage, mémoire des flux, TV (V1.11)
- **Logos** : celui d'iptv-org passe avant celui du fournisseur, qui met parfois l'image d'une autre chaîne sur un flux (CANAL+ sur « TF1 FHD »).
- **Lecture en direct** :
  - la version d'une chaîne qui a fonctionné est mémorisée (`chanPick:<profil>:<groupe>`) et essayée en premier la fois suivante, même après un redémarrage ;
  - passage à la version suivante au bout de 9 s sans première image (14 s pour un blocage en cours de lecture) ;
  - les changements de version et les refus « connexion déjà utilisée » (407 / 509 / 429) s'affichent sous le chargement, sans fenêtre surgissante ; dans ce cas, la même version est réessayée 3 fois avant de passer à la suivante, et le message final indique que l'abonnement est sans doute utilisé ailleurs.
- **Tampon du direct** : il ne s'applique plus par défaut qu'aux flux officiels. La sortie HLS des fournisseurs Xtream démarrait en 10 s ou plus, contre 1,5 à 3 s pour leur flux direct. Une option le réactive pour la source IPTV ; sans lui, la pause garde environ 50 s.
- **Ordre des chaînes stable** : les chaînes de référence nationales reçoivent toujours le bonus de langue, et le programme en cours ne joue qu'au-delà des 12 premières.
- **Liste instantanée** : chaque catégorie de « En direct » enregistre ses 60 premières chaînes avec le programme en cours ; ces listes sont relues au démarrage, avant les grosses lectures du catalogue. Mesuré sur le téléphone : 90 ms au lieu de 3,6 s.
- **Programme TV** : la grille n'est plus remplacée par le chargement quand la liste se rafraîchit ; le défilement jusqu'à l'heure courante tient dès la première ouverture.
- **Synchro** : les listes de films et de séries se téléchargent pendant le traitement des chaînes. Le préchargement en arrière-plan ne repart qu'après un intervalle complet (il retéléchargeait tout juste après la synchro). L'enrichissement TMDB attend 1 min après une première synchro.
- **Replay** : les logos des directs officiels sont enregistrés, un bandeau de même hauteur s'affiche pendant le chargement, et les images du bandeau sont en 1280×720.
- **Télécommande** : un écran « lancement » s'affiche dès la validation d'une lecture ; dans le lecteur, Gauche/Droite restent dans la rangée de boutons (elles ne sautent plus sur la barre de temps).

### Installer sur une TV depuis le téléphone (V1.12)
- Paramètres › « Installer sur une TV » (Android téléphone et tablette uniquement), en 4 étapes :
  1. **Préparer la TV** : explications pour activer le mode développeur et le débogage USB / réseau.
  2. **Choisir la TV** : recherche sur le réseau Wi-Fi.
     - Noms des TV via les annonces mDNS Google Cast (`_googlecast._tcp`, champ `fn`) et Android TV Remote.
     - Débogage détecté par un balayage du /24 sur le port 5555 (48 connexions en parallèle, 450 ms chacune).
     - Une TV vue sans débogage actif est indiquée ; saisie manuelle de l'IP possible.
  3. **Installation** : téléchargement du dernier APK (`update.json` de la dernière release), connexion ADB, autorisation sur la TV si elle ne connaît pas encore le téléphone (aucun appairage), envoi à `cmd package install -r -S` avec progression, puis réponse du gestionnaire de paquets.
  4. **Terminé**, avec le conseil de désactiver le débogage ensuite.
- `AdbClient.java` : client ADB minimal sur TCP (CNXN, AUTH par signature RSA ou envoi de la clé publique, OPEN/WRTE/OKAY/CLSE avec contrôle de flux). Il est sans dépendance Android, donc testable sur une JVM.
  - La clé RSA 2048 du téléphone est créée une fois et conservée.
  - Vérifié : clé publique identique à celle d'`adb keygen`, signature au format attendu par `adbd`, installation d'un APK de 12 Mo en 1,5 s sur un émulateur.
  - Parcours complet testé entre deux émulateurs : détection, téléchargement depuis GitHub, envoi et installation en 7 s.
- Limites :
  - les TV qui n'acceptent le débogage qu'avec un code d'appairage (« débogage sans fil » d'Android 11+, sans port 5555) ne sont pas encore prises en charge ;
  - le téléphone doit avoir Android 8 ou plus ;
  - pas encore testé sur une vraie TV.

### TV avec code d'association, réglages transmis (V1.13)
- **Débogage sans fil (Android 11+)** :
  - **Détection** : annonces mDNS `_adb-tls-connect._tcp` (port de connexion) et `_adb-tls-pairing._tcp` (port d'association, tant que la TV affiche son code).
  - **Connexion** : la TV répond STLS au CNXN, le client passe en TLS 1.3 avec un certificat auto-signé de sa clé RSA (`AdbTls`). Une TV qui ne connaît pas le téléphone refuse le certificat, et l'assistant demande alors le code.
  - **Association** (`AdbPairing`, d'après AOSP `pairing_connection`) :
    - TLS 1.3 avec certificats des deux côtés ;
    - export de 64 octets de la session TLS (`SSLSockets.exportKeyingMaterial`, libellé « adb-label\0 », Android 12+) ajouté au code ;
    - SPAKE2 Ed25519 (`Spake2`, portage de BoringSSL : points M/N vérifiés, ajout de multiples de l'ordre pour que le scalaire du code soit un multiple de 8) ;
    - échange des PeerInfo (8192 octets, clé publique adb) chiffrés en AES-128-GCM, clé dérivée par HKDF-SHA256 « adb pairing_auth aes-128-gcm key », nonce = compteur ;
    - en-têtes de 6 octets.
  - **Validé** sur un émulateur Android 14 en débogage sans fil : avec le code affiché, association en 170 ms, puis le téléphone apparaît dans les appareils associés de la TV.
- **Réglages transmis** : après l'installation, le téléphone lance l'app sur la TV par adb (`am start -d cyberiptv://import/<charge base64url>`).
  - La charge contient le profil (nom, emoji, couleur), les sources actives avec identifiants, la clé TMDB et les préférences. Elle est placée dans le chemin de l'URI, qu'Android ne journalise pas.
  - La TV crée ou complète le profil du même nom, sans dupliquer les sources, l'ouvre et synchronise.
  - Option activée par défaut dans l'assistant. Validé entre deux émulateurs : la TV s'ouvre sur le bon profil, catalogue chargé.
- **Import depuis le téléphone par QR code** : proposé dès l'étape « profil » de la première configuration, et le profil est maintenant importé avec les sources et les préférences.
- **Assistant** : liste des TV lisible (petite icône, nom sur plusieurs lignes), bouton « Terminer » à la fin.
- **Client ADB** : les messages tardifs d'un flux précédent sont ignorés à l'ouverture d'un nouveau.

### Reste à faire / à vérifier
- Test sur une vraie box Android TV (aucune image système TV installée sur ce Mac) et mesure des objectifs du §3.4.
- Vérifier le décodage AC3/E-AC3 via FFmpeg sur un vrai flux IPTV.
- V2 : Cast, timeshift local, téléchargements.
