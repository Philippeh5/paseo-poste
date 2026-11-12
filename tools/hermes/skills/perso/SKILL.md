---
name: perso
description: "Tâches Google, agenda et notes BlastWin pour Philippe."
version: 1.0.0
author: Philippe
platforms: [linux]
metadata:
  hermes:
    tags: [google, tasks, calendar, notes, perso, blastwin]
    category: productivity
    requires_toolsets: [terminal]
---

# /perso — tâches Google, agenda, notes

Commandes Google disponibles dans le terminal d'Oracle (dans `~/Projets/bin`, déjà dans le PATH de Hermes) :

- `gtasks lists` — listes de tâches Google et tâches ouvertes (JSON).
- `gtasks add "Titre" [--due AAAA-MM-JJ] [--list "Mes tâches"] [--notes "…"]` — créer une tâche. Convertis « demain », « lundi »
  en date réelle (fuseau Europe/Paris) avant d'appeler.
- `gtasks done <id_liste> <id_tâche>` — terminer une tâche (cherche d'abord l'id avec `gtasks lists`).
- `gtasks events [--days 7]` — prochains événements.
- `gtasks event-add "Titre" --start 2026-10-25T14:00:00 --end 2026-10-25T15:00:00` — créer un événement.
- **Notes BlastWin** : pas d'outil spécial. Ajoute directement UNE ligne à la fin du fichier `~/Projets/BlastWin/NOTES_TELEGRAM.md` (crée-le avec le titre `# Notes reçues par Telegram` s'il n'existe pas), au format `- **AAAA-MM-JJ HH:MM** — texte`. GitHub la synchronise ensuite sur toutes les machines.

## Règles
- Créer une tâche ou une note : fais-le directement et confirme en une phrase (« Tâche ajoutée : … pour demain »).
- Terminer ou modifier une tâche existante : cite le titre exact avant d'agir si plusieurs correspondent.
- Si `gtasks` répond `invalid_grant` : Google doit être reconnecté (Philippe lance la connexion sur le mini-PC) ; dis-le et propose
  de noter la tâche dans les notes BlastWin en attendant.
- Message vocal : il est transcrit automatiquement ; traite le texte reçu comme un message normal.
