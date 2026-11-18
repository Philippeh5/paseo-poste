# Transfert vers Oracle et reprise automatique — conception (T10)

## Constat qui change l'architecture
Le dashboard et sa base de tâches (le « cerveau ») doivent survivre à l'extinction du mini-PC. Si le cerveau tourne
sur le mini-PC, éteindre le mini-PC l'éteint aussi, et personne ne peut reprendre le travail.

**Proposition: le dashboard et le cerveau tournent sur Oracle** (toujours allumé, joignable seulement par Tailscale,
mot de passe obligatoire). Le mini-PC et Oracle sont deux « machines » identiques pour le cerveau, chacune avec son
daemon Paseo. Le mini-PC peut s'éteindre sans rien perdre: les tâches, les mises en page et l'historique sont sur Oracle.

```
téléphone / PC ──Tailscale──► dashboard + cerveau (Oracle)
                                   │            │
                         daemon Paseo Oracle   daemon Paseo mini-PC (écoute sur l'adresse Tailscale, mot de passe)
                         projets /home/USERNAME  projets D:\Projets
                                   └────── GitHub ──────┘  (les deux machines tirent/poussent les mêmes dépôts)
```

## Prérequis (certains demandent une action de Philippe)
1. Daemon du mini-PC joignable par Tailscale (écoute sur 100.64.0.1:6767), mot de passe, démarrage automatique
   (tâche planifiée Windows), pare-feu Windows limité à l'interface Tailscale.
2. GitHub connecté sur Oracle (`gh auth login` — action de Philippe, je ne copie aucun jeton) + identité git.
3. Dashboard installé sur Oracle (service utilisateur, écoute sur l'adresse Tailscale, `DASHBOARD_PASSWORD` obligatoire).
4. Projets suivis avec un dépôt GitHub (T09).

## Bouton « Transférer vers Oracle »
Confirmation en deux temps, affichant le plan avant d'agir. Étapes, chacune avec un résultat visible et un arrêt à la
première erreur (rien ne s'éteint si une étape échoue):
1. **Contrôle**: liste des projets concernés (ceux qui ont des tâches En cours / À faire sur le mini-PC), agents actifs,
   changements non enregistrés, état de GitHub et d'Oracle (connecté, dépôt présent, espace disque).
2. **Arrêt doux** des agents en cours (fin de tour, ou arrêt après un délai choisi); les sessions interrompues sont notées.
3. **Sauvegarde Git**: sur chaque projet, commit « Transfert vers Oracle <date> » sur une branche `transfert/<date>`
   (jamais sur `main`), puis push vers GitHub.
4. **Mise en place sur Oracle**: clone ou pull de chaque dépôt dans `/home/USERNAME/projets/<nom>`, bascule sur la branche.
5. **Reprise des tâches**: les tâches du mini-PC sont réaffectées à Oracle avec une invite de reprise (objectif,
   dernier commit, ce qui était fait, fichiers modifiés, erreurs vues) et redémarrées.
6. **Extinction du mini-PC** après une dernière confirmation (« Le mini-PC va s'éteindre dans 60 secondes »; annulable).
   Mode simulation (`dryRun`) disponible pour tous les tests: il décrit chaque action sans l'exécuter.

## Reprise automatique (mini-PC muet)
Le cerveau interroge le daemon du mini-PC toutes les 30 secondes. Muet pendant N minutes (défaut 5):
1. Bandeau « Mini-PC injoignable depuis N min » dans le dashboard (et plus tard message Telegram).
2. Pour les tâches En cours marquées « reprise automatique » (case à cocher, décochée par défaut): clone ou pull du dépôt
   sur Oracle depuis GitHub, branche la plus récente, relance avec une invite de reprise.
3. Rien n'est repoussé sur `main`; tout part sur une branche `reprise/<date>`.
4. Quand le mini-PC revient: **pas de retour automatique**; un bandeau propose « Rapatrier » (même procédure inverse).
Limites assumées: le travail non commité du mini-PC éteint brutalement est perdu (seul l'état GitHub existe); une session
vivante ne se déplace pas, on la recrée depuis Git.

## Sécurité
Aucun jeton GitHub ne circule entre machines; chaque machine s'authentifie elle-même. L'extinction n'est possible que
depuis une session authentifiée et passe par la confirmation intégrée. Les journaux ne contiennent aucun secret.
