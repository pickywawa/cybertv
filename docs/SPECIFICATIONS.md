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

- **Android TV / grand écran** : barre de navigation en haut (Accueil · Recherche · TV · Chaînes · Mes vidéos) + avatar profil à droite. Retour = remonter d'un niveau, puis focus sur la barre, puis confirmation de sortie.
- **Mobile** : barre d'onglets en bas (Accueil · Recherche · En direct · Chaînes · Plus).
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

### Reste à faire / à vérifier
- Test sur une vraie box Android TV (aucune image système TV installée sur ce Mac) et mesure des objectifs du §3.4.
- Vérifier le décodage AC3/E-AC3 via FFmpeg sur un vrai flux IPTV.
- V2 : synchro app fermée (WorkManager), Cast, enrôlement par QR code, timeshift local, téléchargements.
